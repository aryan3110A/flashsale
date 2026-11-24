'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { EMAIL_RE } from '@/lib/format';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/Toast';
import { AuthShell, Field, FormError, PasswordInput, SubmitButton, safeNext } from '@/components/AuthForm';
import { Skeleton } from '@/components/ui';

export default function LoginPage() {
  return <Suspense fallback={<Skeleton className="mx-auto h-96 max-w-md" />}><LoginForm /></Suspense>;
}

function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const { user, status, login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  // Already signed in: nothing to do here.
  useEffect(() => { if (status === 'authed') router.replace(next); }, [status, next, router]);

  const errors = {
    email: !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : '',
    password: password.length === 0 ? 'Enter your password.' : '',
  };

  const submit = async () => {
    setTouched(true);
    if (errors.email || errors.password || busy) return;
    setBusy(true); setFailure(null);
    try {
      await login({ email: email.trim().toLowerCase(), password });
      toast.push('success', 'Welcome back', 'You are logged in.');
      router.replace(next);
    } catch (e) {
      setFailure(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message));
    } finally { setBusy(false); }
  };

  if (user) return null;
  return (
    <AuthShell title="Log in" subtitle="Log in to book as yourself and see your tickets without typing your email each time."
      footer={<>New to FlashSale? <Link href={next === '/' ? '/signup' : `/signup?next=${encodeURIComponent(next)}`} className="font-semibold text-accent hover:underline">Create an account</Link></>}>
      <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {failure && (
          <FormError
            message={failure.status === 401 ? 'Incorrect email or password.' : failure.status === 429 ? 'Too many attempts.' : failure.message}
            hint={failure.status === 429 ? `Please wait ${failure.retryAfterSeconds ?? 'a few'} seconds and try again.` : failure.status === 0 ? 'Check that the stack is running.' : undefined} />
        )}
        <Field id="login-email" label="Email" error={touched ? errors.email : ''}>
          <input id="login-email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={touched && !!errors.email} aria-describedby="login-email-err" maxLength={200} />
        </Field>
        <Field id="login-password" label="Password" error={touched ? errors.password : ''}>
          <PasswordInput id="login-password" value={password} onChange={setPassword} autoComplete="current-password" invalid={touched && !!errors.password} />
        </Field>
        <SubmitButton busy={busy}>Log in</SubmitButton>
      </form>
    </AuthShell>
  );
}
