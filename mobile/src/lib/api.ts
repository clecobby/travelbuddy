import Constants from 'expo-constants';
import { getIdToken } from './cognito';

// EXPO_PUBLIC_API_URL points at a deployed server. Without it, use the backend on the machine serving the JS bundle
// (works on simulators and on phones on the same Wi-Fi).
const devHost = Constants.expoConfig?.hostUri?.split(':')[0] || 'localhost';
export const API = process.env.EXPO_PUBLIC_API_URL || `http://${devHost}:4100`;

// The signed-in screen registers this so an expired or revoked sign-in sends you back to the login screen.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// Every request carries the Cognito ID token (refreshed automatically when it's about to expire).
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T = any>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers = await authHeaders();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(`Can't reach the Travel Buddy server.`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && headers.Authorization) onUnauthorized();
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
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
