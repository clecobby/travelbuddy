// Voice for Expo Go (no on-device speech recognition there): hold the mic to record a short clip,
// the server transcribes it (Amazon Transcribe), then it's handled like a typed question.
// No wake word in this mode: listening all the time would mean streaming the car's audio to the cloud.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import {
  AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { File, UploadType } from 'expo-file-system';
import { API, authHeaders } from './api';

// 16 kHz mono 16-bit PCM WAV: what Transcribe streams natively, and small (~32 KB per second).
const RECORDING: RecordingOptions = {
  extension: '.wav',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: { outputFormat: 'default', audioEncoder: 'default' }, // not supported by the server yet (iOS only)
  web: {},
};

const MIN_MS = 400; // shorter than this is an accidental tap

export function useRecordedVoice({ onCommand }: { onCommand: (text: string) => void }) {
  const recorder = useAudioRecorder(RECORDING);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const recordingRef = useRef(false);
  const onCommandRef = useRef(onCommand);
  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);

  const pushToTalk = useCallback(async () => {
    setError(null);
    await Speech.stop();
    if (Platform.OS !== 'ios') return setError('Voice in Expo Go works on iPhone only for now. Type your question instead.');
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return setError('Microphone permission is off.');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    recordingRef.current = true;
    startedAt.current = Date.now();
    setListening(true);
  }, [recorder]);

  const finishPushToTalk = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setListening(false);
    await recorder.stop();
    // Back to playback mode so replies come out of the speaker, not the earpiece.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    if (!uri || Date.now() - startedAt.current < MIN_MS) return;
    setPartial('…');
    try {
      const res = await new File(uri).upload(`${API}/api/transcribe`, {
        httpMethod: 'POST',
        uploadType: UploadType.BINARY_CONTENT,
        headers: { ...(await authHeaders()), 'Content-Type': 'audio/wav' },
      });
      const data = JSON.parse(res.body || '{}');
      if (res.status >= 400) throw new Error(data.error || `Transcription failed (${res.status})`);
      const text = String(data.text ?? '').trim();
      if (text) onCommandRef.current(text);
      else setError("I didn't catch that. Hold the mic and try again.");
    } catch (e) {
      setError((e as Error).message || "Can't reach the Travel Buddy server.");
    } finally {
      setPartial('');
      new File(uri).delete?.();
    }
  }, [recorder]);

  const speak = useCallback((text: string) => {
    setSpeaking(true);
    const done = () => setSpeaking(false);
    Speech.speak(text, { rate: 1.0, onDone: done, onStopped: done, onError: done });
  }, []);

  const shutUp = useCallback(() => void Speech.stop(), []);

  useEffect(() => () => void Speech.stop(), []);

  return {
    supportsHandsFree: false,
    handsFree: false,
    setHandsFree: (_on: boolean) => setError('Hands-free "travel buddy" needs the full Travel Buddy app. In Expo Go, hold the mic to talk.'),
    listening,
    speaking,
    partial,
    awaitingQuestion: false,
    error,
    pushToTalk,
    finishPushToTalk,
    speak,
    shutUp,
  };
}
