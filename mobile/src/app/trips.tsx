import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { api, type Trip } from '@/lib/api';
import { colors } from '@/lib/theme';

export default function Trips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api<Trip[]>('/trips')
      .then((t) => {
        setTrips(t);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useFocusEffect(load);

  return (
    <FlatList
      data={trips}
      keyExtractor={(t) => t.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.muted} />}
      ListEmptyComponent={<Text style={s.empty}>{error ?? 'No trips yet. Say “travel buddy, start recording this trip”.'}</Text>}
      renderItem={({ item }) => (
        <Link href={{ pathname: '/trip/[id]', params: { id: item.id } }} asChild>
          <Pressable style={s.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {item.status === 'recording' && <View style={s.dot} />}
              <Text style={s.title}>{item.title}</Text>
            </View>
            <Text style={s.meta}>
              {new Date(item.started_at).toLocaleString()} · {item.snapshots ?? 0} snapshots · {item.videos ?? 0} clips
            </Text>
          </Pressable>
        </Link>
      )}
    />
  );
}

const s = StyleSheet.create({
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40, fontSize: 15 },
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.line },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  meta: { color: colors.muted, marginTop: 4, fontSize: 13 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.rec },
});
