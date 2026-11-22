import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

// Accounts live in Amazon Cognito. The app's Cognito calls go through our API (/api/cognito), which forwards
// them: some mobile networks can't reach cognito-idp directly but can reach our API. The password travels
// over TLS to our API and on to Cognito; the server never stores it.
const CLIENT_ID = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID ?? '';
const devHost = Constants.expoConfig?.hostUri?.split(':')[0] || 'localhost';
const API = process.env.EXPO_PUBLIC_API_URL || `http://${devHost}:4100`;

export class AuthError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

async function call<T = any>(action: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/cognito`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, body: { ClientId: CLIENT_ID, ...body } }),
    });
  } catch {
    throw new AuthError('NetworkError', "Can't reach Travel Buddy. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(String(data.__type || '').split('#').pop() || 'Error', data.message || 'Something went wrong');
  return data as T;
}

// Short, human messages for the screens.
const MESSAGES: Record<string, string> = {
  UsernameExistsException: 'An account with this email already exists. Try logging in.',
  NotAuthorizedException: 'Wrong email or password.',
  UserNotFoundException: 'Wrong email or password.',
  CodeMismatchException: "That code isn't right. Check your email and try again.",
  ExpiredCodeException: 'That code has expired. Send a new one.',
  LimitExceededException: 'Too many attempts. Wait a bit and try again.',
  TooManyRequestsException: 'Too many attempts. Wait a bit and try again.',
  InvalidPasswordException: 'Password needs 10+ characters with upper and lower case letters and a number.',
  InvalidParameterException: 'Please check what you entered.',
  CodeDeliveryFailureException: "We couldn't send the email. Check the address.",
};
export const authMessage = (e: unknown) => MESSAGES[(e as Error)?.name] || (e as Error)?.message || 'Something went wrong';

// ---- session (each token in its own SecureStore key: values there should stay small) ----

const KEYS = ['idToken', 'accessToken', 'refreshToken', 'expiresAt'] as const;
type Session = Record<(typeof KEYS)[number], string>;
type AuthResult = { IdToken: string; AccessToken: string; RefreshToken?: string; ExpiresIn: number };

let session: Session | null | undefined; // undefined = not loaded from storage yet

async function saveSession(r: AuthResult, previousRefresh?: string) {
  session = {
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken || previousRefresh || '',
    expiresAt: String(Date.now() + r.ExpiresIn * 1000),
  };
  await Promise.all(KEYS.map((k) => SecureStore.setItemAsync(k, session![k])));
}

async function clearSession() {
  session = null;
  await Promise.all(KEYS.map((k) => SecureStore.deleteItemAsync(k)));
}

export async function loadSession() {
  const values = await Promise.all(KEYS.map((k) => SecureStore.getItemAsync(k)));
  session = values[2] ? (Object.fromEntries(KEYS.map((k, i) => [k, values[i] ?? ''])) as Session) : null;
  return !!session;
}

// A valid ID token for our API, refreshed when it's about to expire. Null when signed out.
// Also works in the background location task, where nothing has loaded the session yet.
let refreshing: Promise<void> | null = null;
export async function getIdToken(): Promise<string | null> {
  if (session === undefined) await loadSession();
  if (!session) return null;
  if (Date.now() < Number(session.expiresAt) - 60_000) return session.idToken;
  const refreshToken = session.refreshToken;
  refreshing ??= call<{ AuthenticationResult: AuthResult }>('GetTokensFromRefreshToken', { RefreshToken: refreshToken })
    .then((r) => saveSession(r.AuthenticationResult, refreshToken))
    .catch(async (e) => {
      // Only a rejected refresh token signs you out; no signal on the road just means "try again later".
      if ((e as Error).name !== 'NetworkError') await clearSession();
    })
    .finally(() => (refreshing = null));
  await refreshing;
  return session?.idToken ?? null;
}

// ---- account flows ----

// Kept in memory only, so confirming the email can sign straight in without typing the password again.
let pending: { email: string; password: string } | null = null;
export const rememberForAutoSignIn = (email: string, password: string) => (pending = { email, password });
export function takeAutoSignIn(email: string) {
  const p = pending?.email === email ? pending : null;
  pending = null;
  return p;
}

export const signUp = (email: string, password: string) =>
  call('SignUp', { Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }] });

export const confirmSignUp = (email: string, code: string) => call('ConfirmSignUp', { Username: email, ConfirmationCode: code });

export const resendCode = (email: string) => call('ResendConfirmationCode', { Username: email });

// 'DONE', or 'CONFIRM_SIGN_UP' when the account exists but the email isn't confirmed yet.
export async function signIn(email: string, password: string): Promise<'DONE' | 'CONFIRM_SIGN_UP'> {
  try {
    const r = await call<{ AuthenticationResult: AuthResult }>('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    await saveSession(r.AuthenticationResult);
    return 'DONE';
  } catch (e) {
    if ((e as Error).name === 'UserNotConfirmedException') return 'CONFIRM_SIGN_UP';
    throw e;
  }
}

export async function signOut() {
  if (session?.refreshToken) await call('RevokeToken', { Token: session.refreshToken }).catch(() => {});
  await clearSession();
}

// After the server has deleted the account.
export const forgetSession = clearSession;

export const forgotPassword = (email: string) => call('ForgotPassword', { Username: email });

export const confirmForgotPassword = (email: string, code: string, password: string) =>
  call('ConfirmForgotPassword', { Username: email, ConfirmationCode: code, Password: password });
