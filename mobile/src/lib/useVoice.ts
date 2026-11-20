import { requireOptionalNativeModule } from 'expo';
import { useRecordedVoice } from './useRecordedVoice';
import type { useNativeVoice as UseNativeVoice } from './useNativeVoice';

// The full app ships on-device speech recognition (wake word + live transcription). Expo Go doesn't,
// so there we fall back to hold-to-talk recordings transcribed by the server.
// Decided once at startup, so the same hook runs on every render.
const hasSpeechRecognition = requireOptionalNativeModule('ExpoSpeechRecognition') != null;

export const useVoice: typeof useRecordedVoice | typeof UseNativeVoice = hasSpeechRecognition
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./useNativeVoice') as { useNativeVoice: typeof UseNativeVoice }).useNativeVoice
  : useRecordedVoice;
