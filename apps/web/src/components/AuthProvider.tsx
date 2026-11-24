'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { clearToken, getToken, setToken } from '@/lib/auth-token';
import { saveContact } from '@/lib/storage';
import type { AuthUser } from '@/lib/types';

type Status = 'loading' | 'authed' | 'guest';
interface AuthCtx {
  user: AuthUser | null;
  status: Status;
  signup: (input: { name: string; email: string; password: string }) => Promise<void>;
  login: (input: { email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  // Restore the session after mount (the token only exists in the browser).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) { setStatus('guest'); return; }
      try {
        const r = await api.me();
        if (!cancelled) { setUser(r.data.user); setStatus('authed'); }
      } catch (e) {
        // A rejected token is dead for good; a network failure keeps it so the next load can retry.
        if (e instanceof ApiError && e.status === 401) clearToken();
        if (!cancelled) setStatus('guest');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const adopt = useCallback((r: { user: AuthUser; token: string }) => {
    setToken(r.token);
    setUser(r.user);
    setStatus('authed');
    saveContact({ name: r.user.name, email: r.user.email });
  }, []);

  const signup = useCallback(async (input: { name: string; email: string; password: string }) => { adopt((await api.signup(input)).data); }, [adopt]);
  const login = useCallback(async (input: { email: string; password: string }) => { adopt((await api.login(input)).data); }, [adopt]);
  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* the token is discarded locally either way */ }
    clearToken();
    setUser(null);
    setStatus('guest');
  }, []);

  const value = useMemo(() => ({ user, status, signup, login, logout }), [user, status, signup, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}
