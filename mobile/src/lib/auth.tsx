import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { forgetSession, loadSession, signOut } from './cognito';
import { stopBackgroundTracking } from './backgroundTrack';

// loading → out (no session) | in (signed in, server accepted the token)
type Status = 'loading' | 'out' | 'in';
type Auth = {
  status: Status;
  email: string | null;
  refresh: () => Promise<void>; // after signing in
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
};

const AuthContext = createContext<Auth | null>(null);

export function useAuth() {
  const a = useContext(AuthContext);
  if (!a) throw new Error('useAuth outside AuthProvider');
  return a;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [email, setEmail] = useState<string | null>(null);

  const out = useCallback(() => {
    setEmail(null);
    setStatus('out');
  }, []);

  const logout = useCallback(async () => {
    await stopBackgroundTracking().catch(() => {});
    await signOut();
    out();
  }, [out]);

  const refresh = useCallback(async () => {
    if (!(await loadSession())) return out();
    try {
      const me = await api<{ email: string }>('/me');
      setEmail(me.email);
      setStatus('in');
    } catch (e) {
      // No signal at launch: stay signed in with what's on the phone; only a refused token signs you out.
      if (e instanceof ApiError && e.status === 0) setStatus('in');
      else await logout();
    }
  }, [logout, out]);

  const deleteAccount = useCallback(async () => {
    await stopBackgroundTracking().catch(() => {});
    await api('/me', { method: 'DELETE' });
    await forgetSession();
    out();
  }, [out]);

  useEffect(() => {
    setUnauthorizedHandler(() => void logout());
    // refresh() awaits SecureStore before touching state, so this doesn't set state synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh, logout]);

  return <AuthContext.Provider value={{ status, email, refresh, logout, deleteAccount }}>{children}</AuthContext.Provider>;
}
