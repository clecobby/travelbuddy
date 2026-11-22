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
import { routeMeters, useTripRoute } from '@/lib/useTripRoute';
import { startBackgroundTracking, stopBackgroundTracking, type BackgroundState } from '@/lib/backgroundTrack';
import { RouteMap } from '@/components/RouteMap';
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
  const [background, setBackground] = useState<BackgroundState | null>(null);
  // When background tracking runs, it uploads the route itself; otherwise the foreground watcher does.
  const { fix, place, area, error: locError } = useLocation(trip && background !== 'on' ? trip.id : null);
  const route = useTripRoute(trip?.id ?? null, fix);

  // A recording trip keeps mapping the route with the screen locked (standalone app, "Always" location).
  useEffect(() => {
    if (!trip?.id) {
      setBackground(null);
      void stopBackgroundTracking().catch(() => {});
      return;
    }
    startBackgroundTracking(trip.id)
      .then(setBackground)
      .catch(() => setBackground('off'));
  }, [trip?.id]);
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

  const km = routeMeters(route) / 1000;
  const kmh = fix?.speed != null && fix.speed > 0.5 ? Math.round(fix.speed * 3.6) : 0;

  return (
    <View style={s.root}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Top bar: where you are */}
        <View style={[s.top, { paddingTop: insets.top + 8 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.brand}>
              travel<Text style={{ color: colors.accent }}>buddy</Text>
            </Text>
            <Text style={s.place} numberOfLines={1}>
              {place ?? locError ?? (fix ? 'Finding the address…' : 'Finding you…')}
            </Text>
          </View>
          <Link href="/trips" asChild>
            <Pressable style={s.pill}>
              <Text style={s.pillText}>Trips</Text>
            </Pressable>
          </Link>
          <Link href="/account" asChild>
            <Pressable style={s.pill} accessibilityLabel="Account">
              <Text style={s.pillText}>Me</Text>
            </Pressable>
          </Link>
        </View>

        {/* Top half: what you see (camera) with the conversation over it */}
        <View style={s.pane}>
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

          {trip && (
            <View style={s.recBar}>
              <View style={[s.dot, { opacity: recording ? 1 : 0.4 }]} />
              <Text style={s.recText} numberOfLines={1}>
                {trip.title} · {clips} clips{uploads.queued ? ` · ${uploads.queued} uploading` : ''} · {(uploads.uploadedBytes / 1e6).toFixed(0)} MB saved
              </Text>
            </View>
          )}
          {uploads.lastError && <Text style={s.warn}>Upload problem: {uploads.lastError} (retrying)</Text>}

          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.lines} ref={(r) => r?.scrollToEnd({ animated: true })}>
            {lines.length === 0 && (
              <Text style={s.hint}>Ask me about where you are, or say “travel buddy, start recording this trip”.</Text>
            )}
            {lines.slice(-6).map((l, i) => (
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
        </View>

        {/* Bottom half: the map, your route filling in as you go */}
        <View style={s.pane}>
          <RouteMap
            route={route}
            live
            follow={fix ? { latitude: fix.lat, longitude: fix.lng, heading: fix.heading, speed: fix.speed } : null}
            style={StyleSheet.absoluteFill}
          />
          <View style={s.stats} pointerEvents="none">
            <Stat value={trip ? km.toFixed(km < 10 ? 2 : 1) : '–'} unit="km" />
            <Stat value={trip ? elapsed(trip.started_at) : '–'} unit="time" />
            <Stat value={String(kmh)} unit="km/h" />
          </View>
          {trip && (background === 'expo-go' || background === 'no-permission') && (
            <Text style={[s.warn, s.mapNote]}>
              {background === 'expo-go'
                ? 'Route pauses while the phone is locked in Expo Go. The full app keeps tracking.'
                : 'Allow location "Always" in Settings to keep mapping while the phone is locked.'}
            </Text>
          )}
        </View>

        {/* Controls */}
        <View style={[s.controls, { paddingBottom: insets.bottom + 10 }]}>
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

function Stat({ value, unit }: { value: string; unit: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statUnit}>{unit}</Text>
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
  top: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingBottom: 10, backgroundColor: colors.overlay, gap: 8 },
  brand: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  place: { color: colors.muted, fontSize: 13, marginTop: 2 },
  pill: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginTop: 4 },
  pillText: { color: colors.text, fontWeight: '600' },
  recBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(255,69,58,0.18)' },
  pane: { flex: 1, overflow: 'hidden', borderTopWidth: 1, borderColor: colors.line },
  stats: { position: 'absolute', left: 12, right: 12, top: 10, flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: colors.overlay, borderRadius: 12, paddingVertical: 6, alignItems: 'center' },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statUnit: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  mapNote: { position: 'absolute', left: 12, right: 12, bottom: 10, borderRadius: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.rec },
  recText: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
  warn: { color: '#ffd60a', fontSize: 12, paddingHorizontal: 16, paddingVertical: 4, backgroundColor: colors.overlay },
  lines: { padding: 12, gap: 6, flexGrow: 1, justifyContent: 'flex-end' },
  hint: { color: colors.text, fontSize: 16, textAlign: 'center', opacity: 0.8, backgroundColor: colors.overlay, padding: 14, borderRadius: 14 },
  bubble: { maxWidth: '85%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  you: { alignSelf: 'flex-end', backgroundColor: 'rgba(61,220,151,0.85)' },
  buddy: { alignSelf: 'flex-start', backgroundColor: colors.overlay, borderWidth: 1, borderColor: colors.line },
  placeTag: { alignSelf: 'center', backgroundColor: colors.overlay, paddingVertical: 5 },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 21 },
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
