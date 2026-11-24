'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Fetch on mount / when deps change, with loading + error state and manual reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ data: s.data, error: e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message), loading: false }));
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); }, deps);
  return { ...state, reload: run };
}

/** Run `fn` every `ms` while mounted (and visible). Returns last success timestamp and error. */
export function usePolling<T>(fn: () => Promise<T>, ms: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const tick = useCallback(async () => {
    setRefreshing(true);
    try { const d = await fnRef.current(); setData(d); setError(null); setUpdatedAt(Date.now()); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message)); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => void tick(), 0);
    const id = setInterval(() => { if (document.visibilityState === 'visible') void tick(); }, ms);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [ms, enabled, tick]);
  return { data, error, updatedAt, refreshing, refresh: tick };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}
