# Travel Buddy

A voice travel companion. Point your phone's camera at the road and talk to it:

- **“Travel buddy, start recording this trip”** starts filming compressed video clips, saves a snapshot from each clip, and logs your GPS track. Everything uploads to S3 as you go.
- **“What's the story behind this town?” / “What's that building?” / “Anything happening here tonight?”** Claude answers out loud. It knows where you are, sees the camera, and searches the web for live info.
- **“How far have we gone?” / “Stop recording.”**

```
mobile/    iOS + Android app: Expo SDK 58, Expo Router, TypeScript
backend/   Express + SQLite (node:sqlite) in TypeScript, run directly by Node 26 (no build step) → http://localhost:4100
```

## Run it

```bash
# 1. Backend
cd backend
cp .env.example .env          # add ANTHROPIC_API_KEY; MEDIA_BUCKET optional (see below)
npm install && npm run dev

# 2. Phone app: needs a development build (speech recognition is a native module that Expo Go doesn't include)
cd mobile
npm install
npx expo run:ios --device     # or: npx expo run:android --device / eas build --profile development
```

Your phone must be on the same Wi-Fi as your computer. The app finds the backend on the machine serving the JS bundle.
To use a deployed backend, set `EXPO_PUBLIC_API_URL` in `mobile/.env`. If the backend has `APP_TOKEN` set, put the same value in `EXPO_PUBLIC_APP_TOKEN`.

Without `MEDIA_BUCKET`, uploads go to `backend/uploads/`, which is good enough for trying it out.

## Storage on S3

Set `MEDIA_BUCKET` (and `AWS_REGION`) in `backend/.env`. The server signs short-lived PUT URLs and the phone uploads directly to S3, so video never passes through the server. AWS credentials come from the normal chain (`aws login`, `~/.aws`, or an instance role) and need `s3:PutObject` + `s3:GetObject` on `arn:aws:s3:::<bucket>/trips/*`.

Layout:
```
trips/<tripId>/video/<ts>-<rand>.mov|mp4     15-second H.264 clips, ~1.2 Mbit/s (~540 MB/hour)
trips/<tripId>/snapshots/<ts>-<rand>.jpg     last frame of each clip, 1024 px wide, JPEG q60 (~80 KB)
```
GPS points, trip metadata and the conversation live in SQLite (`backend/travelbuddy.db`).

## How it works

| Piece | Where |
|---|---|
| Wake word + push-to-talk speech recognition, spoken replies | [mobile/src/lib/useVoice.ts](mobile/src/lib/useVoice.ts) (`expo-speech-recognition`, `expo-speech`) |
| Clip-by-clip video recording, snapshot extraction, "current view" for the model | [mobile/src/lib/useTripRecorder.ts](mobile/src/lib/useTripRecorder.ts), [frames.ts](mobile/src/lib/frames.ts) |
| Upload queue with retries (presign → PUT → record) | [mobile/src/lib/uploads.ts](mobile/src/lib/uploads.ts) |
| GPS tracking, address lookup, batched track upload | [mobile/src/lib/useLocation.ts](mobile/src/lib/useLocation.ts) |
| Claude conversation, tools (web search, start/stop trip, trip stats) | [backend/src/buddy.ts](backend/src/buddy.ts) |
| API routes | [backend/src/server.ts](backend/src/server.ts) |

**Hands-free mode** listens continuously and ignores everything that doesn't start with “travel buddy” (so passengers and the radio don't trigger it). Say just “travel buddy” and it answers “Yeah?”, then waits for your question. The mic pauses while it talks so it doesn't hear itself. **Hold the mic button** to talk without the wake word.

**Location does the explaining.** Each turn includes the closest Wikipedia landmarks with distance and direction. Directions are relative to travel when you're moving ("on the left", "ahead on the right") and compass points otherwise. So "what's that castle on the left?" just works. Claude can also look further around (`nearby_places`, up to 10 km) and pull a verified Wikipedia summary (`place_info`). These lookups run on the server and send only coordinates ([backend/src/places.ts](backend/src/places.ts)). **Guide mode** (on by default) says a one-line welcome whenever you enter a new town, but waits until nobody is talking.

**The model** is Claude Opus 5.5 at low effort, tuned for quick spoken answers. Server-side refusal fallback is enabled (`fallbacks: "default"`), so if a safety classifier declines a request, the API retries it on a fallback model in the same call. Each turn sends the time, GPS position, nearest address, trip status, and (when the camera is on) the current frame. Conversations are kept per device per day, so follow-up questions work.

## Known limits (MVP)

- **Foreground only.** Recording and GPS stop if you lock the phone or leave the app (the screen is kept awake while it's open). Background location would need `expo-task-manager` and the background-location plugin options.
- **Video clips are silent.** The microphone is reserved for talking to Travel Buddy, and sharing it with the video recorder is unreliable on iOS.
- **About 1 second of footage is lost** between 15-second clips while the camera restarts recording.
- **No accounts.** A random device id identifies you. Set `APP_TOKEN` before exposing the server so strangers can't spend your Claude credits. For real users, add Cognito the way the `dating` app does.
- The upload queue lives in memory. Clips not yet uploaded when the app is killed stay on the phone's cache but won't be retried.
