import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import type { ApiError } from '@/lib/api';

export function Skeleton({ className = '' }: { className?: string }) { return <div className={`skeleton ${className}`} aria-hidden />; }

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-accent">{eyebrow}</p>}
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <Inbox className="h-10 w-10 text-muted" aria-hidden />
      <h3 className="text-lg font-semibold">{title}</h3>
      {body && <p className="max-w-md text-sm text-muted">{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="card flex flex-col items-center gap-3 border-bad/40 px-6 py-12 text-center">
      <AlertTriangle className="h-10 w-10 text-bad" aria-hidden />
      <h3 className="text-lg font-semibold">{error.code === 'NETWORK_ERROR' ? 'Backend unreachable' : 'Could not load this'}</h3>
      <p className="max-w-md text-sm text-muted">{error.message}</p>
      {error.requestId && <p className="num text-xs text-muted">Request ID: {error.requestId}</p>}
      {onRetry && <button className="btn btn-ghost" onClick={onRetry}><RefreshCw className="h-4 w-4" /> Try again</button>}
    </div>
  );
}

const PILL: Record<string, string> = {
  CONFIRMED: 'bg-good/15 text-good border-good/30',
  PROCESSING: 'bg-flash/15 text-flash border-flash/30',
  FAILED: 'bg-bad/15 text-bad border-bad/30',
  healthy: 'bg-good/15 text-good border-good/30',
  degraded: 'bg-flash/15 text-flash border-flash/30',
  unhealthy: 'bg-bad/15 text-bad border-bad/30',
  unknown: 'bg-white/10 text-muted border-line',
  CLOSED: 'bg-good/15 text-good border-good/30',
  HALF_OPEN: 'bg-flash/15 text-flash border-flash/30',
  OPEN: 'bg-bad/15 text-bad border-bad/30',
};
export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${PILL[status] ?? PILL.unknown}`}><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />{label ?? status}</span>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'bad' | 'warn' }) {
  const color = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`num mt-1 text-2xl font-bold ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
