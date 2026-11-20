import { useEffect, useRef } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { colors } from '@/lib/theme';
import type { RoutePoint } from '@/lib/useTripRoute';

type Follow = { latitude: number; longitude: number; heading?: number | null; speed?: number | null };

// A trip's route on a map, drawn as a thick line that grows as you move.
// live: follows `follow` (your current position; the map turns with your heading while you move).
// otherwise: frames the whole route.
export function RouteMap({
  route,
  live,
  follow,
  style,
}: {
  route: RoutePoint[];
  live?: boolean;
  follow?: Follow | null;
  style?: StyleProp<ViewStyle>;
}) {
  const map = useRef<MapView>(null);
  const last = route[route.length - 1];
  const lat = follow?.latitude ?? last?.latitude;
  const lng = follow?.longitude ?? last?.longitude;
  const moving = (follow?.speed ?? 0) > 1.5 && (follow?.heading ?? -1) >= 0;
  const heading = moving ? Math.round(follow!.heading! / 10) * 10 : 0; // rounded so the map doesn't jitter

  // Live: follow the newest position (only when it actually changes, not on every re-render).
  useEffect(() => {
    if (live && map.current && lat != null && lng != null)
      map.current.animateCamera({ center: { latitude: lat, longitude: lng }, heading }, { duration: 700 });
  }, [live, lat, lng, heading]);

  // Finished trip: frame the whole route (again once the map has laid out).
  const frame = () => {
    if (!live && map.current && route.length)
      map.current.fitToCoordinates(route, { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: false });
  };
  useEffect(frame);

  return (
    <MapView
      ref={map}
      onMapReady={frame}
      style={[styles.map, style]}
      userInterfaceStyle="dark"
      showsUserLocation={live}
      showsCompass={false}
      toolbarEnabled={false}
      pitchEnabled={false}
      initialCamera={lat != null && lng != null ? { center: { latitude: lat, longitude: lng }, zoom: 16, heading: 0, pitch: 0 } : undefined}
    >
      {route.length > 1 && (
        <>
          {/* dark casing under the colored line keeps it readable on any map */}
          <Polyline coordinates={route} strokeColor="rgba(0,0,0,0.55)" strokeWidth={10} lineCap="round" lineJoin="round" />
          <Polyline coordinates={route} strokeColor={colors.route} strokeWidth={6} lineCap="round" lineJoin="round" />
        </>
      )}
      {route.length > 0 && <Marker coordinate={route[0]} pinColor="green" title="Start" />}
      {!live && route.length > 1 && <Marker coordinate={last} pinColor="red" title="End" />}
    </MapView>
  );
}

const styles = StyleSheet.create({ map: { overflow: 'hidden' } });
