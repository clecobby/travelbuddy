import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { Link } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type BuddyAction, type Trip } from '@/lib/api';
import { colors } from '@/lib/theme';
import { useLocation, type Fix } from '@/lib/useLocation';
import { useTripRecorder, VIDEO_BITRATE } from '@/lib/useTripRecorder';
import { useVoice } from '@/lib/useVoice';
import { onUploadState } from '@/lib/uploads';

type Line = { from: 'you' | 'buddy' | 'place'; text: string };

const pad = (n: number) => String(n).padStart(2, '0');
function nowForBuddy() {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    localTime: `${d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (${tz})`,
    localDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  };
}
function elapsed(since: number) {
  const s = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export default function Companion() {
  useKeepAwake(); // a travel companion that falls asleep isn't much of one
  const insets = useSafeAreaInsets();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [lines, setLines] = useState<Line[]>([]);
  const [thinking, setThinking] = useState(false);
  const [typed, setTyped] = useState('');
  const [uploads, setUploads] = useState({ queued: 0, uploadedBytes: 0, lastError: null as string | null });
  const [, tick] = useState(0);

  const camera = useRef<CameraView>(null);
  const { fix, place, area, error: locError } = useLocation(trip?.id ?? null);
  const [guide, setGuide] = useState(true); // speak up on arriving somewhere new
  const announced = useRef<string | null>(null);
  const fixRef = useRef<Fix | null>(null);
  useEffect(() => {
    fixRef.current = fix;
  }, [fix]);

  const showCamera = cameraOn || !!trip; // a recording trip always films
  const { recording, clips, currentFrame } = useTripRecorder({ camera, cameraReady: showCamera && cameraReady, tripId: trip?.id ?? null, fixRef });

  useEffect(() => onUploadState(setUploads), []);
  useEffect(() => {
    api<Trip | null>('/trips/active').then(setTrip).catch(() => {});
  }, []);
  useEffect(() => {
    if (!trip) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [trip]);
  // Switching between photo and video mode re-initializes the camera.
  useEffect(() => setCameraReady(false), [showCamera, trip?.id]);

  const ensureCamera = useCallback(async () => {
    if (camPerm?.granted) return true;
    return (await requestCamPerm()).granted;
  }, [camPerm, requestCamPerm]);

  const applyActions = useCallback(
    async (actions: BuddyAction[]) => {
      for (const a of actions) {
        if (a.type === 'trip_started') {
          await ensureCamera();
          setTrip(a.trip);
        } else if (a.type === 'trip_stopped') {
          setTrip(null);
        }
      }
    },
    [ensureCamera],
  );

  const voiceRef = useRef<ReturnType<typeof useVoice> | null>(null);
  const ask = useCallback(
    async (text: string, opts: { arrived?: boolean } = {}) => {
      setLines((l) => [...l.slice(-20), opts.arrived ? { from: 'place', text: `📍 ${text}` } : { from: 'you', text }]);
      setThinking(true);
      try {
        const image = showCamera ? await currentFrame() : null;
        const res = await api<{ reply: string; actions: BuddyAction[] }>('/chat', {
          method: 'POST',
          body: {
            text,
            ...nowForBuddy(),
            location: fixRef.current,
            place,
            image,
            arrived: !!opts.arrived,
          },
        });
        await applyActions(res.actions);
        setLines((l) => [...l, { from: 'buddy', text: res.reply }]);
        voiceRef.current?.speak(res.reply);
      } catch (e: any) {
        const msg = e?.message ?? 'Something went wrong.';
        setLines((l) => [...l, { from: 'buddy', text: msg }]);
        voiceRef.current?.speak(msg);
      } finally {
        setThinking(false);
      }
    },
    [applyActions, currentFrame, place, showCamera],
  );

  const voice = useVoice({ onCommand: ask });
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  // Guide mode: when you enter a new town, Travel Buddy says a line about it without being asked.
  // Waits until nobody is talking, so it never interrupts a conversation.
  const idle = !thinking && !voice.speaking && !voice.partial;
  useEffect(() => {
    if (!guide || !area || !idle || area === announced.current) return;
    announced.current = area;
    void ask(area, { arrived: true });
  }, [guide, area, idle, ask]);

  const toggleTrip = async () => {
    try {
      if (trip) {
        await api(`/trips/${trip.id}/stop`, { method: 'POST' });
        setTrip(null);
      } else {
        await ensureCamera();
        setTrip(await api<Trip>('/trips', { method: 'POST', body: { title: place?.split(', ').slice(-3, -2)[0] || 'My trip' } }));
      }
    } catch (e: any) {
      setLines((l) => [...l, { from: 'buddy', text: e?.message ?? 'Could not change the trip.' }]);
    }
  };

  const toggleCamera = async () => {
    if (cameraOn) return setCameraOn(false);
    if (await ensureCamera()) setCameraOn(true);
  };

  const sendTyped = () => {
    const t = typed.trim();
    if (!t) return;
    setTyped('');
    void ask(t);
  };

  const status = voice.speaking
    ? 'Talking…'
    : thinking
      ? 'Thinking…'
      : voice.listening
        ? voice.handsFree && !voice.partial && !voice.awaitingQuestion
          ? 'Listening for “travel buddy”'
          : 'Listening…'
        : voice.handsFree
          ? 'Hands-free paused'
          : 'Hold the mic to talk';

  return (
    <View style={s.root}>
      {showCamera && camPerm?.granted ? (
        <CameraView
          ref={camera}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode={trip ? 'video' : 'picture'}
          mute // the mic belongs to the voice assistant; video clips are silent
          videoQuality="720p"
          videoBitrate={VIDEO_BITRATE}
          onCameraReady={() => setCameraReady(true)}
          onMountError={(e) => setLines((l) => [...l, { from: 'buddy', text: `Camera error: ${e.message}` }])}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.noCam]} />
      )}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Top bar: where you are + trip status */}
        <View style={[s.top, { paddingTop: insets.top + 8 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.brand}>
              travel<Text style={{ color: colors.accent }}>buddy</Text>
            </Text>
            <Text style={s.place} numberOfLines={2}>
              {place ?? locError ?? (fix ? 'Finding the address…' : 'Finding you…')}
            </Text>
          </View>
          <Link href="/trips" asChild>
            <Pressable style={s.pill}>
              <Text style={s.pillText}>Trips</Text>
            </Pressable>
          </Link>
        </View>

        {trip && (
          <View style={s.recBar}>
            <View style={[s.dot, { opacity: recording ? 1 : 0.4 }]} />
            <Text style={s.recText} numberOfLines={1}>
              {trip.title} · {elapsed(trip.started_at)} · {clips} clips
              {uploads.queued ? ` · ${uploads.queued} uploading` : ''} · {(uploads.uploadedBytes / 1e6).toFixed(0)} MB saved
            </Text>
          </View>
        )}
        {uploads.lastError && <Text style={s.warn}>Upload problem: {uploads.lastError} (retrying)</Text>}

        {/* Conversation */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.lines} ref={(r) => r?.scrollToEnd({ animated: true })}>
          {lines.length === 0 && (
            <Text style={s.hint}>
              Ask me about where you are, or say “travel buddy, start recording this trip”.
            </Text>
          )}
          {lines.slice(-8).map((l, i) => (
            <View key={i} style={[s.bubble, l.from === 'you' ? s.you : l.from === 'place' ? s.placeTag : s.buddy]}>
              <Text style={s.bubbleText}>{l.text}</Text>
            </View>
          ))}
          {!!voice.partial && (
            <View style={[s.bubble, s.you, { opacity: 0.6 }]}>
              <Text style={s.bubbleText}>{voice.partial}</Text>
            </View>
          )}
          {thinking && <ActivityIndicator color={colors.accent} style={{ alignSelf: 'flex-start', margin: 8 }} />}
        </ScrollView>

        {/* Controls */}
        <View style={[s.controls, { paddingBottom: insets.bottom + 12 }]}>
          <Text style={s.status}>{voice.error ?? status}</Text>
          <View style={s.row}>
            {voice.supportsHandsFree && (
              <Chip label={voice.handsFree ? 'Hands-free' : 'Hands-free off'} on={voice.handsFree} onPress={() => voice.setHandsFree(!voice.handsFree)} />
            )}
            <Chip label={guide ? 'Guide' : 'Guide off'} on={guide} onPress={() => setGuide(!guide)} />
            <Chip label={showCamera ? 'Camera on' : 'Camera off'} on={showCamera} onPress={toggleCamera} disabled={!!trip} />
            <Chip label={trip ? '■ Stop trip' : '● Record trip'} on={!!trip} rec onPress={toggleTrip} />
          </View>
          <View style={s.row}>
            <TextInput
              value={typed}
              onChangeText={setTyped}
              onSubmitEditing={sendTyped}
              placeholder="…or type a question"
              placeholderTextColor={colors.muted}
              style={s.input}
              returnKeyType="send"
              keyboardAppearance="dark"
            />
            <Pressable
              onPressIn={voice.speaking ? voice.shutUp : voice.pushToTalk}
              onPressOut={voice.finishPushToTalk}
              style={({ pressed }) => [s.mic, (pressed || (voice.listening && !voice.handsFree)) && s.micOn]}
            >
              <Text style={s.micText}>{voice.speaking ? '■' : '🎙'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Chip({ label, on, rec, disabled, onPress }: { label: string; on: boolean; rec?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[s.chip, on && { backgroundColor: rec ? colors.rec : colors.accent, borderColor: 'transparent' }, disabled && { opacity: 0.5 }]}
    >
      <Text style={[s.chipText, on && { color: rec ? '#fff' : colors.bg }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  noCam: { backgroundColor: colors.bg },
  top: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingBottom: 10, backgroundColor: colors.overlay, gap: 12 },
  brand: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  place: { color: colors.muted, fontSize: 13, marginTop: 2 },
  pill: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginTop: 4 },
  pillText: { color: colors.text, fontWeight: '600' },
  recBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(255,69,58,0.18)' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.rec },
  recText: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
  warn: { color: '#ffd60a', fontSize: 12, paddingHorizontal: 16, paddingVertical: 4, backgroundColor: colors.overlay },
  lines: { padding: 16, gap: 8, flexGrow: 1, justifyContent: 'flex-end' },
  hint: { color: colors.text, fontSize: 16, textAlign: 'center', opacity: 0.8, backgroundColor: colors.overlay, padding: 14, borderRadius: 14 },
  bubble: { maxWidth: '85%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  you: { alignSelf: 'flex-end', backgroundColor: 'rgba(61,220,151,0.85)' },
  buddy: { alignSelf: 'flex-start', backgroundColor: colors.overlay, borderWidth: 1, borderColor: colors.line },
  placeTag: { alignSelf: 'center', backgroundColor: colors.overlay, paddingVertical: 5 },
  bubbleText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  controls: { paddingHorizontal: 16, paddingTop: 10, gap: 10, backgroundColor: colors.overlay },
  status: { color: colors.muted, textAlign: 'center', fontSize: 13 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.surface },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  input: { flex: 1, backgroundColor: colors.surface, color: colors.text, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
  mic: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.accent },
  micOn: { backgroundColor: colors.accent, transform: [{ scale: 1.08 }] },
  micText: { fontSize: 26, color: colors.text },
});
