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
  // 'starting' between start() and the recognizer's 'start' event. An 'end' arriving then belongs to the
  // session we just aborted (e.g. hands-free listening) and must not cancel the new one.
  const session = useRef<'none' | 'starting' | 'running'>('none');
  const holding = useRef(false); // finger is on the mic button
  const delivered = useRef(false); // this push-to-talk session already sent its text
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
    if (m === 'push' && !holding.current) return; // released before we got going
    mode.current = m;
    session.current = 'starting';
    delivered.current = false;
    transcript.current = '';
    setPartial(m === 'push' ? '…' : '');
    // Push-to-talk is continuous too, so a pause mid-sentence doesn't end it; releasing the button does.
    ExpoSpeechRecognitionModule.start({ ...recognitionOptions, continuous: true });
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

  // Send what push-to-talk heard (once), or say we heard nothing.
  const finishPush = useCallback(() => {
    mode.current = 'idle';
    if (delivered.current) return;
    delivered.current = true;
    if (transcript.current.trim()) deliver(transcript.current);
    else {
      setPartial('');
      setError("I didn't catch that. Hold the mic while you talk.");
      setTimeout(resumeWake, 300); // no reply coming, so go back to hands-free listening if it's on
    }
  }, [deliver, resumeWake]);

  useSpeechRecognitionEvent('start', () => {
    if (session.current === 'starting') session.current = 'running';
    setListening(true);
  });
  useSpeechRecognitionEvent('end', () => {
    if (session.current === 'starting') return; // the previous, aborted session ending
    session.current = 'none';
    setListening(false);
    if (mode.current === 'wake') {
      mode.current = 'idle';
      setTimeout(resumeWake, 300); // iOS ends continuous sessions after about a minute
    } else if (mode.current === 'push') {
      finishPush(); // ended without a final result (released, or the OS cut it off)
    }
  });
  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results[0]?.transcript ?? '';
    if (mode.current === 'push') {
      if (text) {
        transcript.current = text;
        setPartial(text);
      }
      if (e.isFinal && !holding.current) finishPush();
      return;
    }
    transcript.current = text;
    if (mode.current === 'wake') {
      const inFollowUp = Date.now() < followUpUntil.current;
      if (WAKE.test(text) || inFollowUp) setPartial(text.replace(WAKE, ''));
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      silenceTimer.current = setTimeout(settleWakeUtterance, e.isFinal ? 200 : SILENCE_MS);
    }
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (session.current === 'starting' && e.error !== 'aborted') session.current = 'none'; // new session failed to start
    if (e.error === 'aborted') return;
    if (e.error === 'no-speech') {
      if (mode.current === 'push') finishPush();
      return;
    }
    if (mode.current === 'push') {
      mode.current = 'idle';
      setPartial('');
    }
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
    holding.current = true;
    setError(null);
    if (speakingRef.current) await Speech.stop();
    if (mode.current !== 'idle') stop();
    await start('push');
    if (mode.current === 'idle') resumeWake(); // released before recognition started
  }, [resumeWake, start, stop]);

  const finishPushToTalk = useCallback(() => {
    holding.current = false;
    // Stopping (not aborting) makes iOS send the final transcript, then 'end'.
    if (mode.current === 'push') ExpoSpeechRecognitionModule.stop();
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
