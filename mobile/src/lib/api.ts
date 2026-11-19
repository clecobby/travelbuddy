import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

// EXPO_PUBLIC_API_URL points at a deployed server. Without it, use the backend on the machine serving the JS bundle
// (works on simulators and on phones on the same Wi-Fi).
const devHost = Constants.expoConfig?.hostUri?.split(':')[0] || 'localhost';
export const API = process.env.EXPO_PUBLIC_API_URL || `http://${devHost}:4100`;
const APP_TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN;

// A random id created on first launch; the server keys trips and conversations on it.
let deviceId: Promise<string> | null = null;
export function getDeviceId() {
  deviceId ??= (async () => {
    let id = await SecureStore.getItemAsync('deviceId');
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
      await SecureStore.setItemAsync('deviceId', id);
    }
    return id;
  })();
  return deviceId;
}

export async function api<T = any>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-device-id': await getDeviceId() };
  if (APP_TOKEN) headers['x-app-token'] = APP_TOKEN;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`Can't reach the Travel Buddy server (${API}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export type Trip = {
  id: string;
  title: string;
  status: 'recording' | 'ended';
  started_at: number;
  ended_at: number | null;
  snapshots?: number;
  videos?: number;
};

export type BuddyAction = { type: 'trip_started'; trip: Trip } | { type: 'trip_stopped'; trip: Trip };
