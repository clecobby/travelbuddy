// Keeps recording the trip's route while the phone is locked or the app is in the background.
// iOS/Android wake this task with new locations; it batches them and posts them to the trip.
// Needs the standalone app (Expo Go can't run background location) and "Always" location permission.
// This file must be imported at app start (see app/_layout.tsx) so the task is defined before the OS calls it.
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';

const TASK = 'travelbuddy-trip-route';
const TRIP_KEY = 'trackingTripId';
const FLUSH_MS = 30_000; // one request per 30 s keeps battery and data use low

export const backgroundTrackingSupported = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

type Point = { t: number; lat: number; lng: number; accuracy: number | null; speed: number | null };
const pending: Point[] = [];
let lastFlush = 0;

async function flush(force = false) {
  if (!pending.length || (!force && Date.now() - lastFlush < FLUSH_MS)) return;
  const tripId = await SecureStore.getItemAsync(TRIP_KEY);
  if (!tripId) return void pending.splice(0);
  lastFlush = Date.now();
  const batch = pending.splice(0);
  try {
    await api(`/trips/${tripId}/points`, { method: 'POST', body: { points: batch } });
  } catch {
    pending.unshift(...batch.slice(-5000)); // no signal (tunnel, mountains): keep them for the next try
  }
}

if (backgroundTrackingSupported) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    for (const l of data.locations)
      pending.push({ t: l.timestamp, lat: l.coords.latitude, lng: l.coords.longitude, accuracy: l.coords.accuracy, speed: l.coords.speed });
    await flush();
  });
}

export type BackgroundState = 'on' | 'expo-go' | 'no-permission' | 'off';

// Called when a trip starts (or the app reopens with a trip still recording).
export async function startBackgroundTracking(tripId: string): Promise<BackgroundState> {
  if (!backgroundTrackingSupported) return 'expo-go';
  await SecureStore.setItemAsync(TRIP_KEY, tripId);
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return 'no-permission';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return 'no-permission';
  if (!(await Location.hasStartedLocationUpdatesAsync(TASK))) {
    await Location.startLocationUpdatesAsync(TASK, {
      accuracy: Location.Accuracy.High,
      distanceInterval: 15,
      timeInterval: 5000,
      activityType: Location.ActivityType.Other, // walking, driving or on a train
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true, // the blue pill in the status bar, so it's never secret
      foregroundService: {
        notificationTitle: 'Travel Buddy is mapping your trip',
        notificationBody: 'Your route keeps recording while the phone is locked.',
        notificationColor: '#3ddc97',
      },
    });
  }
  return 'on';
}

export async function stopBackgroundTracking() {
  await flush(true);
  await SecureStore.deleteItemAsync(TRIP_KEY);
  if (backgroundTrackingSupported && (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false)))
    await Location.stopLocationUpdatesAsync(TASK);
}
