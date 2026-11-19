#!/usr/bin/env bash
# One-time (re-runnable) AWS setup for one stage. Creates whatever is missing, leaves the rest alone.
#   deploy/bootstrap-aws.sh dev
#   deploy/bootstrap-aws.sh prod
#
# Per stage:  DynamoDB table travelbuddy-<stage>, S3 bucket travelbuddy-media-<stage>-<account>,
#             Lambda travelbuddy-api-<stage> with a public Function URL (guarded by the app token),
#             CodeBuild project + CodePipeline travelbuddy-<stage>, triggered by pushes to its branch on CodeCommit.
# Shared:     CodeCommit repo travelbuddy, pipeline artifact bucket, pipeline/events roles.
#
# Secrets live in SSM Parameter Store:
#   /travelbuddy/anthropic-key        Anthropic API key (SecureString) - copied into the Lambda's environment on each run
#   /travelbuddy/<stage>/app-token    generated here; the API requires it and the app ships with it
#   /travelbuddy/expo-token           Expo access token so CodeBuild can publish over-the-air updates
set -euo pipefail
NEW_ROLE=0
export AWS_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
STAGE="${1:?usage: bootstrap-aws.sh dev|prod}"
case "$STAGE" in dev) BRANCH=dev ;; prod) BRANCH=main ;; *) echo "stage must be dev or prod" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TABLE=travelbuddy-$STAGE
BUCKET=travelbuddy-media-$STAGE-$ACCOUNT
FUNCTION=travelbuddy-api-$STAGE
REPO=travelbuddy
ARTIFACTS=travelbuddy-pipeline-$ACCOUNT
exists() { "$@" >/dev/null 2>&1; }
say() { echo "• $*"; }

ensure_role() { # name, trust service, inline policy json
  if ! exists aws iam get-role --role-name "$1"; then
    aws iam create-role --role-name "$1" --assume-role-policy-document \
      "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"$2\"},\"Action\":\"sts:AssumeRole\"}]}" >/dev/null
    say "created role $1"; NEW_ROLE=1
  fi
  aws iam put-role-policy --role-name "$1" --policy-name main --policy-document "$3"
}

# ---- data ----
if ! exists aws dynamodb describe-table --table-name "$TABLE"; then
  aws dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE"
  aws dynamodb update-continuous-backups --table-name "$TABLE" --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null
  say "created table $TABLE"
fi

if ! exists aws s3api head-bucket --bucket "$BUCKET"; then
  aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  say "created bucket $BUCKET"
fi

# ---- secrets ----
if ! exists aws ssm get-parameter --name "/travelbuddy/$STAGE/app-token"; then
  aws ssm put-parameter --name "/travelbuddy/$STAGE/app-token" --type SecureString --value "$(openssl rand -hex 24)" >/dev/null
  say "generated /travelbuddy/$STAGE/app-token"
fi
APP_TOKEN=$(aws ssm get-parameter --name "/travelbuddy/$STAGE/app-token" --with-decryption --query Parameter.Value --output text)
ANTHROPIC_KEY=$(aws ssm get-parameter --name /travelbuddy/anthropic-key --with-decryption --query Parameter.Value --output text 2>/dev/null || true)
[ -n "$ANTHROPIC_KEY" ] || echo "! /travelbuddy/anthropic-key is not in SSM yet: chat will fail until you add it and re-run this script"

# ---- API ----
ensure_role "$FUNCTION" lambda.amazonaws.com "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:/aws/lambda/$FUNCTION*"},
 {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:Query","dynamodb:BatchWriteItem"],"Resource":"arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$TABLE"},
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject"],"Resource":["arn:aws:s3:::$BUCKET/trips/*","arn:aws:s3:::$BUCKET/convos/*"]}
]}
JSON
)"
[ "$NEW_ROLE" = 1 ] && sleep 10 # new IAM roles take a moment before Lambda accepts them

ENV="Variables={STAGE=$STAGE,TABLE=$TABLE,MEDIA_BUCKET=$BUCKET,APP_TOKEN=$APP_TOKEN,ANTHROPIC_API_KEY=${ANTHROPIC_KEY:-unset},NODE_OPTIONS=--enable-source-maps}"
if ! exists aws lambda get-function --function-name "$FUNCTION"; then
  (cd "$ROOT/backend" && npm ci --no-audit --no-fund --silent && npm run build --silent)
  (cd "$ROOT/backend/dist" && zip -qj /tmp/$FUNCTION.zip lambda.mjs)
  aws lambda create-function --function-name "$FUNCTION" --runtime nodejs24.x --architectures arm64 \
    --handler lambda.handler --memory-size 1024 --timeout 120 \
    --role "arn:aws:iam::$ACCOUNT:role/$FUNCTION" --zip-file "fileb:///tmp/$FUNCTION.zip" --environment "$ENV" >/dev/null
  aws lambda wait function-active-v2 --function-name "$FUNCTION"
  say "created function $FUNCTION"
else
  aws lambda update-function-configuration --function-name "$FUNCTION" --environment "$ENV" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FUNCTION"
fi

if ! exists aws lambda get-function-url-config --function-name "$FUNCTION"; then
  aws lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --statement-id public-url --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --statement-id public-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
  say "created function URL"
fi
API_URL=$(aws lambda get-function-url-config --function-name "$FUNCTION" --query FunctionUrl --output text | sed 's:/$::')

# ---- pipeline ----
exists aws codecommit get-repository --repository-name "$REPO" || {
  aws codecommit create-repository --repository-name "$REPO" --repository-description "Travel Buddy" >/dev/null; say "created CodeCommit repo $REPO"; }
exists aws s3api head-bucket --bucket "$ARTIFACTS" || { aws s3api create-bucket --bucket "$ARTIFACTS" >/dev/null; say "created bucket $ARTIFACTS"; }

ensure_role "travelbuddy-build-$STAGE" codebuild.amazonaws.com "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:/aws/codebuild/travelbuddy-$STAGE*"},
 {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:PutObject"],"Resource":"arn:aws:s3:::$ARTIFACTS/*"},
 {"Effect":"Allow","Action":["lambda:UpdateFunctionCode","lambda:GetFunction","lambda:GetFunctionConfiguration"],"Resource":"arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:$FUNCTION"},
 {"Effect":"Allow","Action":"ssm:GetParameter","Resource":["arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter/travelbuddy/expo-token","arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter/travelbuddy/$STAGE/app-token"]}
]}
JSON
)"
ensure_role travelbuddy-pipeline codepipeline.amazonaws.com "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:PutObject","s3:GetBucketVersioning"],"Resource":["arn:aws:s3:::$ARTIFACTS","arn:aws:s3:::$ARTIFACTS/*"]},
 {"Effect":"Allow","Action":["codecommit:GetBranch","codecommit:GetCommit","codecommit:GetRepository","codecommit:UploadArchive","codecommit:GetUploadArchiveStatus","codecommit:CancelUploadArchive"],"Resource":"arn:aws:codecommit:$AWS_REGION:$ACCOUNT:$REPO"},
 {"Effect":"Allow","Action":["codebuild:StartBuild","codebuild:BatchGetBuilds"],"Resource":"arn:aws:codebuild:$AWS_REGION:$ACCOUNT:project/travelbuddy-*"}
]}
JSON
)"
ensure_role travelbuddy-events events.amazonaws.com "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"codepipeline:StartPipelineExecution","Resource":"arn:aws:codepipeline:$AWS_REGION:$ACCOUNT:travelbuddy-*"}]}
JSON
)"
[ "$NEW_ROLE" = 1 ] && sleep 10

BUILD_ENV="type=LINUX_CONTAINER,image=aws/codebuild/amazonlinux-x86_64-standard:5.0,computeType=BUILD_GENERAL1_SMALL,environmentVariables=[{name=STAGE,value=$STAGE},{name=CHANNEL,value=$STAGE},{name=API_URL,value=$API_URL}]"
if [ "$(aws codebuild batch-get-projects --names "travelbuddy-$STAGE" --query 'length(projects)' --output text)" = 0 ]; then
  aws codebuild create-project --name "travelbuddy-$STAGE" --service-role "arn:aws:iam::$ACCOUNT:role/travelbuddy-build-$STAGE" \
    --source type=CODEPIPELINE,buildspec=deploy/buildspec.yml --artifacts type=CODEPIPELINE --environment "$BUILD_ENV" \
    --cache type=LOCAL,modes=LOCAL_CUSTOM_CACHE >/dev/null
  say "created CodeBuild project travelbuddy-$STAGE"
else
  aws codebuild update-project --name "travelbuddy-$STAGE" --environment "$BUILD_ENV" >/dev/null
fi

PIPELINE=$(cat <<JSON
{"name":"travelbuddy-$STAGE","roleArn":"arn:aws:iam::$ACCOUNT:role/travelbuddy-pipeline","pipelineType":"V2","executionMode":"QUEUED",
 "artifactStore":{"type":"S3","location":"$ARTIFACTS"},
 "stages":[
  {"name":"Source","actions":[{"name":"CodeCommit","actionTypeId":{"category":"Source","owner":"AWS","provider":"CodeCommit","version":"1"},
    "configuration":{"RepositoryName":"$REPO","BranchName":"$BRANCH","PollForSourceChanges":"false","OutputArtifactFormat":"CODE_ZIP"},"outputArtifacts":[{"name":"src"}]}]},
  {"name":"Build","actions":[{"name":"Build","actionTypeId":{"category":"Build","owner":"AWS","provider":"CodeBuild","version":"1"},
    "configuration":{"ProjectName":"travelbuddy-$STAGE"},"inputArtifacts":[{"name":"src"}]}]}]}
JSON
)
if exists aws codepipeline get-pipeline --name "travelbuddy-$STAGE"; then
  aws codepipeline update-pipeline --pipeline "$PIPELINE" >/dev/null
else
  aws codepipeline create-pipeline --pipeline "$PIPELINE" >/dev/null
  say "created pipeline travelbuddy-$STAGE"
fi

aws events put-rule --name "travelbuddy-push-$STAGE" --event-pattern "$(cat <<JSON
{"source":["aws.codecommit"],"detail-type":["CodeCommit Repository State Change"],"resources":["arn:aws:codecommit:$AWS_REGION:$ACCOUNT:$REPO"],
 "detail":{"event":["referenceCreated","referenceUpdated"],"referenceType":["branch"],"referenceName":["$BRANCH"]}}
JSON
)" >/dev/null
aws events put-targets --rule "travelbuddy-push-$STAGE" --targets \
  "Id=pipeline,Arn=arn:aws:codepipeline:$AWS_REGION:$ACCOUNT:travelbuddy-$STAGE,RoleArn=arn:aws:iam::$ACCOUNT:role/travelbuddy-events" >/dev/null

echo
echo "$STAGE ready"
echo "  API:      $API_URL"
echo "  branch:   $BRANCH → pipeline travelbuddy-$STAGE → Lambda $FUNCTION + Expo channel $STAGE"
