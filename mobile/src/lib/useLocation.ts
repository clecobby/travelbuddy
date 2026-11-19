import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { api } from './api';

export type Fix = { lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null; t: number };

function describe(a: Location.LocationGeocodedAddress | undefined) {
  if (!a) return null;
  const street = a.street ? [a.streetNumber, a.street].filter(Boolean).join(' ') : a.name;
  return [street, a.district, a.city, a.region, a.country].filter((v, i, all) => v && all.indexOf(v) === i).join(', ') || null;
}

const metersBetween = (a: Fix, b: Fix) => {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
};

// Follows the phone's position while the app is open, keeps a readable place name,
// and (when tripId is set) streams the GPS track to the server in batches.
export function useLocation(tripId: string | null) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [area, setArea] = useState<string | null>(null); // town/city you're in, for "welcome to…" moments
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Fix[]>([]);
  const lastGeocode = useRef<Fix | null>(null);
  const tripRef = useRef(tripId);
  useEffect(() => {
    tripRef.current = tripId;
  }, [tripId]);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return setError('Location permission is off, so I can only guess where you are.');
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 },
        (loc) => {
          if (cancelled) return;
          const f: Fix = {
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            accuracy: loc.coords.accuracy,
            speed: loc.coords.speed,
            heading: loc.coords.heading,
            t: loc.timestamp,
          };
          setFix(f);
          if (tripRef.current) pending.current.push(f);
          // Reverse geocoding is rate limited by the OS, so only refresh after real movement or a minute.
          const prev = lastGeocode.current;
          if (!prev || metersBetween(prev, f) > 150 || f.t - prev.t > 60_000) {
            lastGeocode.current = f;
            Location.reverseGeocodeAsync({ latitude: f.lat, longitude: f.lng })
              .then((r) => {
                if (cancelled) return;
                setPlace(describe(r[0]));
                const a = r[0];
                const town = a?.city ?? a?.subregion ?? a?.district;
                if (town) setArea([town, a?.country].filter(Boolean).join(', '));
              })
              .catch(() => {});
          }
        },
        (reason) => setError(reason),
      );
    })().catch((e) => setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  // Flush the track every 20 s while a trip is recording (and once more when it stops).
  useEffect(() => {
    if (!tripId) return;
    const flush = () => {
      const batch = pending.current.splice(0);
      if (!batch.length) return;
      api(`/trips/${tripId}/points`, { method: 'POST', body: { points: batch } }).catch(() => {
        pending.current.unshift(...batch); // keep them for the next try (e.g. no signal in a tunnel)
      });
    };
    const timer = setInterval(flush, 20_000);
    return () => {
      clearInterval(timer);
      flush();
    };
  }, [tripId]);

  return { fix, place, area, error };
}
