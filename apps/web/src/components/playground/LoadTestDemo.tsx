'use client';
import { useState } from 'react';
import { Copy, FileBarChart2 } from 'lucide-react';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/components/Toast';
import { Section } from './shared';

interface Report {
  test: string; finishedAt: string; durationSec: number; maxVus: number; requests: number; throughputRps: number;
  avgMs: number; medMs: number; p90Ms: number; p95Ms: number; p99Ms: number; errorRate: number; rateLimited: number;
  thresholdsPassed: boolean | null; notes?: string[];
}

const COMMANDS = [
  { label: 'Smoke test', cmd: 'k6 run load-tests/smoke-test.js' },
  { label: 'Spike test', cmd: 'k6 run load-tests/spike-test.js' },
  { label: 'Sustained load', cmd: 'k6 run load-tests/sustained-load-test.js' },
  { label: 'Concurrent booking (overbooking check)', cmd: 'k6 run load-tests/concurrent-booking-test.js' },
];

export function LoadTestDemo() {
  const toast = useToast();
  const reports = useAsync(async () => {
    const r = await fetch('/reports', { cache: 'no-store' });
    if (!r.ok) throw new Error('reports unavailable');
    return (await r.json()) as { reports: Report[] };
  }, []);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (cmd: string) => {
    try { await navigator.clipboard.writeText(cmd); setCopied(cmd); setTimeout(() => setCopied(null), 1500); } catch { toast.push('info', 'Copy not available', 'Select the command and copy it manually.'); }
  };

  return (
    <Section icon={FileBarChart2} title="5 · Load testing (k6)" blurb="Load tests are never launched from the browser: an unbounded test from a web page could take down the machine it runs on. Run them from a terminal; the newest real results appear below with their timestamps.">
      <ul className="space-y-2">
        {COMMANDS.map((c) => (
          <li key={c.cmd} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-black/20 px-3 py-2">
            <div><p className="text-xs text-muted">{c.label}</p><code className="num text-sm">{c.cmd}</code></div>
            <button className="btn btn-ghost !py-1" onClick={() => copy(c.cmd)} aria-label={`Copy command: ${c.cmd}`}><Copy className="h-4 w-4" aria-hidden /> {copied === c.cmd ? 'Copied' : 'Copy'}</button>
          </li>
        ))}
      </ul>

      <h3 className="mb-2 mt-6 font-semibold">Latest results</h3>
      {reports.loading && !reports.data ? <p className="text-sm text-muted">Loading…</p> :
        reports.error || !reports.data ? <p className="text-sm text-muted">Report store unavailable.</p> :
          reports.data.reports.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">No load-test report yet. Run a command above, then press Refresh.</p> : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="num w-full text-left text-sm">
                <thead className="bg-white/5 text-xs text-muted"><tr>{['Test', 'Finished', 'Requests', 'RPS', 'avg', 'p95', 'p99', 'Errors', '429s', 'Thresholds'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
                <tbody>{reports.data.reports.map((r) => (
                  <tr key={r.test} className="border-t border-line">
                    <td className="px-3 py-2 font-semibold">{r.test}</td><td className="px-3 py-2">{new Date(r.finishedAt).toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2">{r.requests}</td><td className="px-3 py-2">{r.throughputRps.toFixed(1)}</td><td className="px-3 py-2">{r.avgMs.toFixed(0)} ms</td><td className="px-3 py-2">{r.p95Ms.toFixed(0)} ms</td><td className="px-3 py-2">{r.p99Ms.toFixed(0)} ms</td>
                    <td className="px-3 py-2">{(r.errorRate * 100).toFixed(2)}%</td><td className="px-3 py-2">{r.rateLimited}</td>
                    <td className={`px-3 py-2 font-semibold ${r.thresholdsPassed ? 'text-good' : r.thresholdsPassed === false ? 'text-bad' : 'text-muted'}`}>{r.thresholdsPassed === null ? 'n/a' : r.thresholdsPassed ? 'passed' : 'failed'}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
      <button className="btn btn-ghost mt-3" onClick={reports.reload}>Refresh results</button>
    </Section>
  );
}
