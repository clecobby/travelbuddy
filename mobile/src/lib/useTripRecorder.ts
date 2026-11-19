import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraView } from 'expo-camera';
import { captureStill, lastFrameOf } from './frames';
import { enqueueUpload } from './uploads';
import type { Fix } from './useLocation';

// Video is recorded in short clips so each one can be uploaded (and is safe) as soon as it's done,
// instead of one huge file that is lost if the app dies.
const CLIP_SECONDS = 15;
// ~1.2 Mbit/s H.264 ≈ 2.2 MB per clip ≈ 540 MB per hour of driving.
export const VIDEO_BITRATE = 1_200_000;

type Frame = { base64: string; t: number };

export function useTripRecorder({
  camera,
  cameraReady,
  tripId,
  fixRef,
}: {
  camera: RefObject<CameraView | null>;
  cameraReady: boolean;
  tripId: string | null;
  fixRef: RefObject<Fix | null>;
}) {
  const [recording, setRecording] = useState(false);
  const [clips, setClips] = useState(0);
  const latest = useRef<Frame | null>(null);

  // A finished clip: queue the video, pull a snapshot out of it for the trip log and for "what am I looking at?".
  const handleClip = useCallback(async (uri: string, trip: string, t: number) => {
    const fix = fixRef.current;
    enqueueUpload({ tripId: trip, kind: 'video', uri, t, lat: fix?.lat, lng: fix?.lng });
    setClips((n) => n + 1);
    try {
      const frame = await lastFrameOf(uri);
      if (frame.base64) latest.current = { base64: frame.base64, t: Date.now() };
      enqueueUpload({ tripId: trip, kind: 'snapshot', uri: frame.uri, t: Date.now(), lat: fix?.lat, lng: fix?.lng });
    } catch (e) {
      console.warn('snapshot failed', e);
    }
  }, [fixRef]);

  // Record clip after clip while a trip is on and the camera is ready.
  useEffect(() => {
    const cam = camera.current;
    if (!tripId || !cameraReady || !cam) return;
    let stopped = false;
    (async () => {
      setRecording(true);
      while (!stopped) {
        const startedAt = Date.now();
        try {
          const result = await cam.recordAsync({ maxDuration: CLIP_SECONDS, codec: 'avc1' });
          if (result?.uri) void handleClip(result.uri, tripId, startedAt);
        } catch (e) {
          console.warn('recording failed', e);
          await new Promise((r) => setTimeout(r, 2000)); // camera busy or interrupted; try again shortly
        }
      }
      setRecording(false);
    })();
    return () => {
      stopped = true;
      cam.stopRecording(); // resolves the pending recordAsync, so the last clip is still saved
    };
  }, [tripId, cameraReady, camera, handleClip]);

  // The freshest view of what the traveler sees, as base64 JPEG (or null if the camera is off).
  // (React Compiler memoizes this; a manual useCallback can't track the camera ref.)
  const currentFrame = async (): Promise<string | null> => {
    const cam = camera.current;
    if (!cam || !cameraReady) return null;
    if (tripId) {
      // While recording video we can't take photos, so use the last clip's final frame if it's recent.
      const f = latest.current;
      return f && Date.now() - f.t < CLIP_SECONDS * 2500 ? f.base64 : null;
    }
    try {
      return (await captureStill(cam)).base64 ?? null;
    } catch {
      return null;
    }
  };

  return { recording, clips, currentFrame };
}
