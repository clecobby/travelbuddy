import { useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { api, type Trip } from '@/lib/api';
import { colors } from '@/lib/theme';
import { RouteMap } from '@/components/RouteMap';

type Detail = {
  trip: Trip;
  distance_m: number;
  points: { t: number; lat: number; lng: number; accuracy?: number | null }[];
  media: { key: string; kind: 'video' | 'snapshot'; t: number; url: string; bytes: number | null }[];
  conversation: { role: 'user' | 'assistant'; spoken: string; created_at: number }[];
};

const THUMB = (Dimensions.get('window').width - 16 * 2 - 6 * 2) / 3;

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    api<Detail>(`/trips/${id}`)
      .then((d) => {
        setData(d);
        setLoadedAt(Date.now());
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <Text style={s.muted}>{error}</Text>;
  if (!data) return <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />;

  const { trip, media, conversation } = data;
  const end = trip.ended_at ?? loadedAt;
  const minutes = Math.round((end - trip.started_at) / 60000);
  const snaps = media.filter((m) => m.kind === 'snapshot');
  const videos = media.filter((m) => m.kind === 'video');
  const route = data.points.filter((p) => (p.accuracy ?? 0) <= 100).map((p) => ({ latitude: p.lat, longitude: p.lng }));
  const videoMb = videos.reduce((a, v) => a + (v.bytes ?? 0), 0) / 1e6;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
      <Stack.Screen options={{ title: trip.title }} />
      <View style={s.stats}>
        <Stat label="distance" value={`${(data.distance_m / 1000).toFixed(1)} km`} />
        <Stat label="time" value={minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`} />
        <Stat label="video" value={`${videos.length} clips · ${videoMb.toFixed(0)} MB`} />
      </View>
      {route.length > 0 ? (
        <RouteMap route={route} style={{ height: 280 }} />
      ) : (
        <Text style={s.muted}>No route recorded.</Text>
      )}
      <Text style={s.muted}>
        {new Date(trip.started_at).toLocaleString()} {trip.status === 'recording' ? '· recording now' : `→ ${new Date(end).toLocaleTimeString()}`}
      </Text>

      <Text style={s.h}>Snapshots</Text>
      {snaps.length ? (
        <View style={s.grid}>
          {snaps.map((m) => (
            <Image key={m.key} source={m.url} style={{ width: THUMB, height: THUMB, borderRadius: 10, backgroundColor: colors.surface2 }} contentFit="cover" />
          ))}
        </View>
      ) : (
        <Text style={s.muted}>No snapshots yet.</Text>
      )}

      <Text style={s.h}>Conversation</Text>
      {conversation.length ? (
        conversation.map((c, i) => (
          <View key={i} style={[s.bubble, c.role === 'user' ? s.you : s.buddy]}>
            <Text style={s.bubbleText}>{c.spoken}</Text>
          </View>
        ))
      ) : (
        <Text style={s.muted}>No conversation during this trip.</Text>
      )}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  muted: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  h: { color: colors.text, fontSize: 18, fontWeight: '700' },
  stats: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.line },
  statValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  statLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  bubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  you: { alignSelf: 'flex-end', backgroundColor: colors.accentSoft },
  buddy: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 21 },
});
