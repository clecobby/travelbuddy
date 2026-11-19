#!/usr/bin/env bash
# Ship the API code to a stage's Lambda. CodeBuild runs this on every push (see buildspec.yml);
# you can also run it by hand:  deploy/deploy-aws.sh dev
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
STAGE="${1:?usage: deploy-aws.sh dev|prod}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUNCTION=travelbuddy-api-$STAGE

(cd "$ROOT/backend" && npm run build --silent)
ZIP=$(mktemp -d)/api.zip
(cd "$ROOT/backend/dist" && zip -qj "$ZIP" lambda.mjs)
aws lambda update-function-code --function-name "$FUNCTION" --zip-file "fileb://$ZIP" --query LastUpdateStatus --output text
aws lambda wait function-updated-v2 --function-name "$FUNCTION"
echo "API deployed to $FUNCTION"
