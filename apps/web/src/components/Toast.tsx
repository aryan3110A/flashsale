'use client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { ApiError } from '@/lib/api';

type Kind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: Kind; title: string; body?: string }
interface Ctx { push: (kind: Kind, title: string, body?: string) => void; error: (e: unknown, fallbackTitle?: string) => void }

const ToastCtx = createContext<Ctx | null>(null);
export const useToast = () => { const c = useContext(ToastCtx); if (!c) throw new Error('useToast outside provider'); return c; };

const ICON = { success: CheckCircle2, error: TriangleAlert, info: Info };
const COLOR = { success: 'text-good', error: 'text-bad', info: 'text-cyan' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = (id: number) => setItems((l) => l.filter((t) => t.id !== id));
  const push = useCallback((kind: Kind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l.slice(-3), { id, kind, title, body }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);
  // Centralised API error -> toast mapping.
  const error = useCallback((e: unknown, fallbackTitle = 'Something went wrong') => {
    if (e instanceof ApiError) {
      const title = e.status === 429 ? 'Slow down - rate limit hit' : e.code === 'NETWORK_ERROR' ? 'Cannot reach server' : fallbackTitle;
      const retry = e.retryAfterSeconds ? ` Retry in ${e.retryAfterSeconds}s.` : '';
      push('error', title, `${e.message}${retry}`);
    } else push('error', fallbackTitle, (e as Error)?.message);
  }, [push]);
  const value = useMemo(() => ({ push, error }), [push, error]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2" aria-live="polite" role="status">
        {items.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <div key={t.id} className="card flex items-start gap-3 p-3 pr-2" style={{ animation: 'toast-in .2s ease-out' }}>
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${COLOR[t.kind]}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.body && <p className="mt-0.5 text-sm text-muted">{t.body}</p>}
              </div>
              <button className="rounded-md p-1 text-muted hover:bg-white/10 hover:text-white" onClick={() => dismiss(t.id)} aria-label="Dismiss notification"><X className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
