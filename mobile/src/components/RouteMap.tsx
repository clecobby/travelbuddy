import { useEffect, useRef } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { colors } from '@/lib/theme';
import type { RoutePoint } from '@/lib/useTripRoute';

// A trip's route on a map. `live` follows you as you move; otherwise it frames the whole route.
export function RouteMap({ route, live, style }: { route: RoutePoint[]; live?: boolean; style?: StyleProp<ViewStyle> }) {
  const map = useRef<MapView>(null);
  const last = route[route.length - 1];

  const lat = last?.latitude, lng = last?.longitude;
  // Live: follow the newest position (only when it actually moves, not on every re-render).
  useEffect(() => {
    if (live && map.current && lat != null && lng != null) map.current.animateCamera({ center: { latitude: lat, longitude: lng } }, { duration: 600 });
  }, [live, lat, lng]);
  // Finished trip: frame the whole route (again once the map has laid out).
  const frame = () => {
    if (!live && map.current && route.length) map.current.fitToCoordinates(route, { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: false });
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
      initialCamera={last ? { center: last, zoom: 15, heading: 0, pitch: 0 } : undefined}
    >
      {route.length > 1 && <Polyline coordinates={route} strokeColor={colors.accent} strokeWidth={5} />}
      {route.length > 0 && <Marker coordinate={route[0]} pinColor="green" title="Start" />}
      {!live && route.length > 1 && <Marker coordinate={last} pinColor="red" title="End" />}
    </MapView>
  );
}

const styles = StyleSheet.create({ map: { borderRadius: 14, overflow: 'hidden' } });
