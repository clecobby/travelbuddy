// Voice with on-device speech recognition (needs the expo-speech-recognition native module, so not Expo Go):
// hands-free "travel buddy, ..." wake word plus hold-to-talk with live transcription.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';

// "Travel buddy, ..." (speech recognizers often hear "travel body" or "travel bud").
const WAKE = /\b(?:hey\s+)?travel\s*(?:buddy|buddies|body|bud|but he)\b[\s,.!?]*/i;
const SILENCE_MS = 1300; // a pause this long ends a hands-free command
const FOLLOW_UP_MS = 8000; // after a bare "travel buddy", how long to wait for the actual question

const recognitionOptions: ExpoSpeechRecognitionOptions = {
  lang: 'en-US',
  interimResults: true,
  addsPunctuation: true,
  contextualStrings: ['travel buddy', 'start recording', 'stop recording', 'this trip'],
  // Play TTS replies through the speaker, not the earpiece, and allow car/bluetooth headsets.
  iosCategory: {
    category: 'playAndRecord',
    categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
    mode: 'default',
  },
};

type Mode = 'idle' | 'push' | 'wake';

export function useNativeVoice({ onCommand }: { onCommand: (text: string) => void }) {
  const [handsFree, setHandsFree] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [partial, setPartial] = useState('');
  const [awaitingQuestion, setAwaitingQuestion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = useRef<Mode>('idle');
  const handsFreeRef = useRef(false);
  const speakingRef = useRef(false);
  const transcript = useRef('');
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followUpUntil = useRef(0);
  const onCommandRef = useRef(onCommand);
  const speakRef = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);

  const start = useCallback(async (m: Exclude<Mode, 'idle'>) => {
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone or speech permission is off.');
      return;
    }
    mode.current = m;
    transcript.current = '';
    setPartial('');
    ExpoSpeechRecognitionModule.start({ ...recognitionOptions, continuous: m === 'wake' });
  }, []);

  const stop = useCallback(() => {
    mode.current = 'idle';
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    ExpoSpeechRecognitionModule.abort();
  }, []);

  // Restart wake-word listening (after a reply, a timeout, or the OS ending the session).
  const resumeWake = useCallback(() => {
    if (handsFreeRef.current && !speakingRef.current && mode.current !== 'push') void start('wake');
  }, [start]);

  const deliver = useCallback((text: string) => {
    const clean = text.trim();
    setPartial('');
    if (clean) onCommandRef.current(clean);
  }, []);

  // Hands-free: once the speaker pauses, decide whether they were talking to us.
  const settleWakeUtterance = useCallback(() => {
    const heard = transcript.current;
    const match = heard.match(WAKE);
    const inFollowUp = Date.now() < followUpUntil.current;
    if (!match && !inFollowUp) {
      // Not for us (people talking in the car, radio...). Clear and keep listening.
      stop();
      setTimeout(resumeWake, 150);
      return;
    }
    const command = match ? heard.slice(match.index! + match[0].length) : heard;
    stop();
    if (!command.trim()) {
      // Just "travel buddy": acknowledge and listen for the question.
      followUpUntil.current = Date.now() + FOLLOW_UP_MS;
      setAwaitingQuestion(true);
      speakRef.current('Yeah?');
      return;
    }
    followUpUntil.current = 0;
    setAwaitingQuestion(false);
    deliver(command);
  }, [deliver, resumeWake, stop]);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    if (mode.current === 'wake') {
      mode.current = 'idle';
      setTimeout(resumeWake, 300); // iOS ends continuous sessions after about a minute
    } else if (mode.current === 'push') {
      mode.current = 'idle';
    }
  });
  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results[0]?.transcript ?? '';
    transcript.current = text;
    if (mode.current === 'push') {
      setPartial(text);
      if (e.isFinal) {
        mode.current = 'idle';
        deliver(text);
      }
      return;
    }
    if (mode.current === 'wake') {
      const inFollowUp = Date.now() < followUpUntil.current;
      if (WAKE.test(text) || inFollowUp) setPartial(text.replace(WAKE, ''));
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      silenceTimer.current = setTimeout(settleWakeUtterance, e.isFinal ? 200 : SILENCE_MS);
    }
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (e.error === 'aborted' || e.error === 'no-speech') return;
    setError(e.message || e.error);
  });

  // Speak a reply. The mic is paused while talking so Travel Buddy doesn't hear itself.
  const speak = useCallback(
    (text: string) => {
      if (mode.current !== 'idle') stop();
      speakingRef.current = true;
      setSpeaking(true);
      const done = () => {
        speakingRef.current = false;
        setSpeaking(false);
        resumeWake();
      };
      Speech.speak(text, { rate: 1.0, onDone: done, onStopped: done, onError: done });
    },
    [resumeWake, stop],
  );
  useEffect(() => {
    speakRef.current = speak;
  }, [speak]);

  const pushToTalk = useCallback(async () => {
    setError(null);
    if (speakingRef.current) await Speech.stop();
    if (mode.current !== 'idle') stop();
    await start('push');
  }, [start, stop]);

  const finishPushToTalk = useCallback(() => {
    if (mode.current === 'push') ExpoSpeechRecognitionModule.stop(); // emits a final result
  }, []);

  const shutUp = useCallback(() => void Speech.stop(), []);

  useEffect(() => {
    handsFreeRef.current = handsFree;
    if (handsFree) resumeWake();
    else if (mode.current === 'wake') stop();
  }, [handsFree, resumeWake, stop]);

  useEffect(() => () => {
    ExpoSpeechRecognitionModule.abort();
    void Speech.stop();
  }, []);

  return {
    supportsHandsFree: true,
    handsFree,
    setHandsFree,
    listening,
    speaking,
    partial,
    awaitingQuestion,
    error,
    pushToTalk,
    finishPushToTalk,
    speak,
    shutUp,
  };
}
