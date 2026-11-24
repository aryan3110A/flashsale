import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function Section({ icon: Icon, title, blurb, children }: { icon: LucideIcon; title: string; blurb: string; children: ReactNode }) {
  return (
    <section className="card p-6" aria-label={title}>
      <h2 className="flex items-center gap-2 text-xl font-bold"><Icon className="h-5 w-5 text-accent" aria-hidden /> {title}</h2>
      <p className="mb-5 mt-2 max-w-3xl text-sm text-muted">{blurb}</p>
      {children}
    </section>
  );
}

export function MiniStat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return <div className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-muted">{label}</p><p className={`num text-xl font-bold ${color}`}>{value}</p></div>;
}

export function statusTone(status: number) {
  if (status >= 200 && status < 300) return 'text-good';
  if (status === 429) return 'text-warn';
  if (status === 0) return 'text-bad';
  return status >= 500 ? 'text-bad' : 'text-flash';
}

export function ResultRow({ left, status, detail, badge }: { left: string; status: number; detail: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs last:border-0">
      <span className="num w-10 shrink-0 text-muted">{left}</span>
      <span className={`num w-10 shrink-0 font-bold ${statusTone(status)}`}>{status || 'ERR'}</span>
      {badge}
      <span className="num min-w-0 truncate text-muted">{detail}</span>
    </div>
  );
}
