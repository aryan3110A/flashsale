const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const money = (n: number) => inr.format(n);
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (iso: string) => `${fmtDate(iso)} · ${fmtTime(iso)}`;
export const fmtNum = (n: number) => new Intl.NumberFormat('en-IN').format(n);
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`);
export const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
