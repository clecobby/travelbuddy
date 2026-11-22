# Travel Buddy

A voice travel companion. Point your phone's camera at the road and talk to it:

- **“Travel buddy, start recording this trip”** starts filming compressed video clips, saves a snapshot from each clip, and logs your GPS track. Everything uploads to S3 as you go.
- **“What's the story behind this town?” / “What's that building?” / “Anything happening here tonight?”** Claude answers out loud. It knows where you are, sees the camera, and searches the web for live info.
- **“How far have we gone?” / “Stop recording.”**

```
mobile/    iOS + Android app: Expo SDK 58, Expo Router, TypeScript
backend/   Express API in TypeScript → AWS Lambda (Function URL) + DynamoDB + S3 + Amazon Transcribe
deploy/    AWS setup script, CodeBuild spec, manual deploy script
```

## Open it on your phone (Expo Go)

Install **Expo Go**, sign in as `clecobby`, and open the project's **dev** channel from
https://expo.dev/accounts/clecobby/projects/travelbuddy/updates (tap the latest update → Preview → scan the QR code).
Every push to `dev` publishes a new version; Expo Go picks it up the next time you open the project.

In Expo Go you **hold the mic to talk** (the clip is transcribed by Amazon Transcribe on the server, iPhone only for now).
The hands-free "travel buddy, ..." wake word needs on-device speech recognition, which only the standalone build has
(`npx expo run:ios --configuration Release --device`; it updates itself from the same channel).

## Accounts

Sign up with an email and password, confirm the 6-digit code Cognito emails you, and you're in. Trips, routes and
conversations belong to the account, so they survive reinstalls and follow you to another phone.
Login, password reset ("Forgot password?") and account deletion (Me → Delete account, which removes every trip, file and
conversation) are all in the app. Each stage has its own Cognito user pool (`travelbuddy-dev`, `travelbuddy-prod`).
The app's Cognito calls go through the API (`/api/cognito`), and every other API call carries the Cognito ID token
([backend/src/auth.ts](backend/src/auth.ts), [mobile/src/lib/cognito.ts](mobile/src/lib/cognito.ts)).
Cognito's built-in email sender is limited to about 50 emails a day; connect Amazon SES to the user pool before inviting many people.

## Branches and deploys

| Push to | Pipeline | API | App updates (Expo channel) |
|---|---|---|---|
| `dev` | `travelbuddy-dev` | `travelbuddy-api-dev` | `dev` |
| `main` | `travelbuddy-prod` | `travelbuddy-api-prod` | `prod` |

`git push` sends to GitHub and CodeCommit at once (`origin` has both push URLs). CodeCommit starts the pipeline, which
type-checks and deploys the API to Lambda, then publishes the app's JavaScript with `eas update`.
Changes to native code (new native modules, permissions, app.json plugins) need a new build, not just an update.

Secrets live in SSM Parameter Store: `/travelbuddy/anthropic-key` (copied into the Lambdas by `deploy/bootstrap-aws.sh <stage>`),
`/travelbuddy/expo-token` (lets CodeBuild publish updates).
Re-run `deploy/bootstrap-aws.sh dev|prod` after changing the Anthropic key or the infrastructure; it only creates what's missing.

## Run the API locally (optional)

```bash
cd backend && cp .env.example .env   # uses the dev table and bucket; needs AWS credentials
npm install && npm run dev           # http://localhost:4100
```

## Storage

Trip media goes from the phone straight to S3 with presigned PUT URLs (`travelbuddy-media-<stage>-<account>`):
```
trips/<tripId>/video/<ts>-<rand>.mov|mp4     15-second H.264 clips, ~1.2 Mbit/s (~540 MB/hour)
trips/<tripId>/snapshots/<ts>-<rand>.jpg     last frame of each clip, 1024 px wide, JPEG q60 (~80 KB)
convos/...                                   conversation turns too big for a DynamoDB item
```
Trips, GPS points, media records and the conversation live in one DynamoDB table (`travelbuddy-<stage>`, layout in [backend/src/db.ts](backend/src/db.ts)).

## How it works

| Piece | Where |
|---|---|
| Voice: wake word + live transcription in the full app, hold-to-talk + server transcription in Expo Go, spoken replies | [mobile/src/lib/useVoice.ts](mobile/src/lib/useVoice.ts), [useNativeVoice.ts](mobile/src/lib/useNativeVoice.ts), [useRecordedVoice.ts](mobile/src/lib/useRecordedVoice.ts), [backend/src/transcribe.ts](backend/src/transcribe.ts) |
| Clip-by-clip video recording, snapshot extraction, "current view" for the model | [mobile/src/lib/useTripRecorder.ts](mobile/src/lib/useTripRecorder.ts), [frames.ts](mobile/src/lib/frames.ts) |
| Upload queue with retries (presign → PUT → record) | [mobile/src/lib/uploads.ts](mobile/src/lib/uploads.ts) |
| GPS tracking, address lookup, batched track upload | [mobile/src/lib/useLocation.ts](mobile/src/lib/useLocation.ts) |
| Claude conversation, tools (web search, start/stop trip, trip stats) | [backend/src/buddy.ts](backend/src/buddy.ts) |
| API routes | [backend/src/server.ts](backend/src/server.ts) |

**Hands-free mode** listens continuously and ignores everything that doesn't start with “travel buddy” (so passengers and the radio don't trigger it). Say just “travel buddy” and it answers “Yeah?”, then waits for your question. The mic pauses while it talks so it doesn't hear itself. **Hold the mic button** to talk without the wake word.

**Location does the explaining.** Each turn includes the closest Wikipedia landmarks with distance and direction. Directions are relative to travel when you're moving ("on the left", "ahead on the right") and compass points otherwise. So "what's that castle on the left?" just works. Claude can also look further around (`nearby_places`, up to 10 km) and pull a verified Wikipedia summary (`place_info`). These lookups run on the server and send only coordinates ([backend/src/places.ts](backend/src/places.ts)). **Guide mode** (on by default) says a one-line welcome whenever you enter a new town, but waits until nobody is talking.

**The model** is Claude Opus 5.5 at low effort, tuned for quick spoken answers. Server-side refusal fallback is enabled (`fallbacks: "default"`), so if a safety classifier declines a request, the API retries it on a fallback model in the same call. Each turn sends the time, GPS position, nearest address, trip status, and (when the camera is on) the current frame. Conversations are kept per device per day, so follow-up questions work.

## Known limits (MVP)

- **Background:** with a trip recording, the standalone app keeps mapping the route while the phone is locked (needs "Always" location; iOS shows the blue location pill). Video and voice stop in the background; iOS doesn't allow the camera there. Expo Go can't run background location at all, so there the route pauses while the phone is locked.
- **Video clips are silent.** The microphone is reserved for talking to Travel Buddy, and sharing it with the video recorder is unreliable on iOS.
- **About 1 second of footage is lost** between 15-second clips while the camera restarts recording.
- The upload queue lives in memory. Clips not yet uploaded when the app is killed stay on the phone's cache but won't be retried.
