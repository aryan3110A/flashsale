'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Circle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { EMAIL_RE } from '@/lib/format';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/Toast';
import { AuthShell, Field, FormError, PasswordInput, SubmitButton, safeNext } from '@/components/AuthForm';
import { Skeleton } from '@/components/ui';

export default function SignupPage() {
  return <Suspense fallback={<Skeleton className="mx-auto h-[28rem] max-w-md" />}><SignupForm /></Suspense>;
}

function SignupForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const { user, status, signup } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  useEffect(() => { if (status === 'authed') router.replace(next); }, [status, next, router]);

  const rules = [
    { ok: password.length >= 8, label: 'At least 8 characters' },
    { ok: /[A-Za-z]/.test(password), label: 'A letter' },
    { ok: /[0-9]/.test(password), label: 'A digit' },
  ];
  const errors = {
    name: name.trim().length < 2 ? 'Enter your full name (at least 2 characters).' : '',
    email: !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : '',
    password: rules.every((r) => r.ok) ? '' : 'Password does not meet the rules below.',
    confirm: confirm !== password ? 'Passwords do not match.' : '',
  };
  const valid = !errors.name && !errors.email && !errors.password && !errors.confirm;

  const submit = async () => {
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true); setFailure(null);
    try {
      await signup({ name: name.trim(), email: email.trim().toLowerCase(), password });
      toast.push('success', 'Account created', 'You are now logged in.');
      router.replace(next);
    } catch (e) {
      setFailure(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message));
    } finally { setBusy(false); }
  };

  if (user) return null;
  return (
    <AuthShell title="Create your account" subtitle="One account for faster booking. Your tickets are linked to your email."
      footer={<>Already have an account? <Link href={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} className="font-semibold text-accent hover:underline">Log in</Link></>}>
      <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {failure && (
          <FormError message={failure.status === 429 ? 'Too many attempts.' : failure.message}
            hint={failure.code === 'EMAIL_TAKEN' ? 'Use the Log in page instead.' : failure.status === 429 ? `Please wait ${failure.retryAfterSeconds ?? 'a few'} seconds and try again.` : undefined} />
        )}
        <Field id="su-name" label="Full name" error={touched ? errors.name : ''}>
          <input id="su-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!errors.name} aria-describedby="su-name-err" maxLength={100} />
        </Field>
        <Field id="su-email" label="Email" error={touched ? errors.email : ''}>
          <input id="su-email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={touched && !!errors.email} aria-describedby="su-email-err" maxLength={200} />
        </Field>
        <Field id="su-password" label="Password" error={touched ? errors.password : ''}>
          <PasswordInput id="su-password" value={password} onChange={setPassword} autoComplete="new-password" invalid={touched && !!errors.password} />
          <ul className="mt-2 space-y-1 text-xs" aria-label="Password rules">
            {rules.map((r) => (
              <li key={r.label} className={`flex items-center gap-2 ${r.ok ? 'text-good' : 'text-muted'}`}>
                {r.ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <Circle className="h-3.5 w-3.5" aria-hidden />}{r.label}<span className="sr-only">{r.ok ? ' (met)' : ' (not met)'}</span>
              </li>
            ))}
          </ul>
        </Field>
        <Field id="su-confirm" label="Confirm password" error={touched ? errors.confirm : ''}>
          <PasswordInput id="su-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={touched && !!errors.confirm} />
        </Field>
        <SubmitButton busy={busy}>Create account</SubmitButton>
        <p className="mt-4 text-xs text-muted">Demo note: emails are not verified. If you booked as a guest with this email before, signing up links those bookings to your new account.</p>
      </form>
    </AuthShell>
  );
}
