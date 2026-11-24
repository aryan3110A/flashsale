'use client';
import { useState, type ReactNode } from 'react';
import { Eye, EyeOff, Loader2, XCircle } from 'lucide-react';

/** Where to go after login/sign-up. Only same-site paths are accepted (no open redirects). */
export function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
}

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="card p-6 sm:p-8">
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
      <p className="mt-5 text-center text-sm text-muted">{footer}</p>
    </div>
  );
}

export function FormError({ message, hint }: { message: string; hint?: string }) {
  return (
    <div role="alert" className="mb-5 rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm" data-testid="auth-error">
      <p className="flex items-center gap-2 font-semibold text-bad"><XCircle className="h-4 w-4" aria-hidden /> {message}</p>
      {hint && <p className="mt-1 text-muted">{hint}</p>}
    </div>
  );
}

export function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="label">{label}</label>
      {children}
      <p id={`${id}-err`} className="mt-1 min-h-4 text-xs text-bad">{error}</p>
    </div>
  );
}

export function PasswordInput({ id, value, onChange, autoComplete, invalid, placeholder }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={show ? 'text' : 'password'} className="input pr-12" value={value} onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete} aria-invalid={invalid} aria-describedby={`${id}-err`} maxLength={128} placeholder={placeholder} />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted hover:text-white" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
        {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button type="submit" className="btn btn-primary w-full !py-3 text-base" disabled={busy}>
      {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Please wait…</> : children}
    </button>
  );
}
