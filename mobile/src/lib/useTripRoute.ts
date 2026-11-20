import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { api } from './api';
import type { Fix } from './useLocation';

export type RoutePoint = { latitude: number; longitude: number };
const good = (accuracy: number | null | undefined) => (accuracy ?? 0) <= 100;

// The route of the trip being recorded, for the live map: what the server already has
// (including anything recorded in the background) plus fixes that arrived since.
export function useTripRoute(tripId: string | null, fix: Fix | null) {
  const [saved, setSaved] = useState<{ tripId: string; points: RoutePoint[] } | null>(null);
  const [trail, setTrail] = useState<{ tripId: string | null; points: RoutePoint[] }>({ tripId, points: [] });
  const [lastFix, setLastFix] = useState(fix);

  // New fix while recording: extend the trail (adjusting state during render, as React recommends).
  if (fix !== lastFix) {
    setLastFix(fix);
    if (tripId && fix && good(fix.accuracy))
      setTrail((t) => ({ tripId, points: [...(t.tripId === tripId ? t.points : []), { latitude: fix.lat, longitude: fix.lng }] }));
  }

  useEffect(() => {
    if (!tripId) return;
    let cancelled = false;
    const load = () =>
      api<{ points: { lat: number; lng: number; accuracy?: number | null }[] }>(`/trips/${tripId}`)
        .then((d) => {
          if (cancelled) return;
          setSaved({ tripId, points: d.points.filter((p) => good(p.accuracy)).map((p) => ({ latitude: p.lat, longitude: p.lng })) });
          setTrail({ tripId, points: [] }); // the server copy now covers them
        })
        .catch(() => {});
    void load();
    // Coming back to the app: pick up the part of the route recorded while it was in the background.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void load());
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [tripId]);

  if (!tripId) return [];
  return [...(saved?.tripId === tripId ? saved.points : []), ...(trail.tripId === tripId ? trail.points : [])];
}
