import { KeyRound, Lock } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { StatusBanner, useAuthQueryStatusMessage } from './TalentAuthStatus';

const RECOVERY_SUCCESS_COPY = 'If this email is on an approved Sway performer account, we sent a link.';

type LoginStatus = 'idle' | 'submitting' | 'success' | 'error';
type RecoveryStatus = 'idle' | 'submitting' | 'success' | 'error';

export default function TalentLoginCard() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>('idle');
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const signupHref = useMemo(() => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return '/talent/signup';
    return `/talent/signup?email=${encodeURIComponent(normalizedEmail)}`;
  }, [email]);

  const statusMessage = useAuthQueryStatusMessage({
    'invalid-link': 'This sign-in or verification link is no longer valid. Request a fresh recovery link if you still need help.',
    unavailable: 'Performer sign-in is temporarily unavailable. Please try again in a moment.',
    verified: 'Your email is verified. Log in to open your Sway performer console.'
  });

  const handleLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);

    try {
      const response = await fetch('/api/talent/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          password
        })
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Performer login failed.');
      }

      const redirectPath = typeof data?.redirectPath === 'string' ? data.redirectPath : '/talent';
      window.location.assign(redirectPath);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'We could not log you in right now.');
    }
  };

  const handleRecoverySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (recoveryStatus === 'submitting') return;

    setRecoveryStatus('submitting');
    setRecoveryMessage(null);

    try {
      const response = await fetch('/api/talent/login/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email
        })
      });

      if (!response.ok) {
        throw new Error('Performer recovery link request failed.');
      }

      setRecoveryStatus('success');
      setRecoveryMessage(RECOVERY_SUCCESS_COPY);
    } catch (error) {
      console.warn('Unable to request performer recovery link:', error);
      setRecoveryStatus('error');
      setRecoveryMessage('We could not send a recovery link right now. Please try again in a moment.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
          <Lock className="h-5 w-5" />
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-fuchsia-300">Performer Access</p>
        <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-white">Log in to your Sway performer console</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Use your performer email and password to access <code>/talent</code>. Recovery links stay available if you need account help.
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          New to Sway? <a className="font-bold text-fuchsia-300 hover:text-fuchsia-200" href="/talent/signup">Create a performer account</a>
        </p>

        {statusMessage ? <StatusBanner tone="amber" message={statusMessage} /> : null}

        {message ? <StatusBanner tone="rose" message={message} /> : null}
        {status === 'error' ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <a
              href={signupHref}
              className="inline-flex min-h-10 items-center justify-center rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-black text-cyan-100 transition hover:bg-cyan-500/20"
            >
              Use this email to create account
            </a>
            <button
              type="button"
              onClick={() => {
                const form = document.getElementById('talent-login-recovery-form') as HTMLFormElement | null;
                form?.requestSubmit();
              }}
              className="inline-flex min-h-10 items-center justify-center rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2 text-xs font-black text-fuchsia-100 transition hover:bg-fuchsia-500/20"
            >
              Send recovery link instead
            </button>
          </div>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={handleLoginSubmit}>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-login-email">
              Email
            </label>
            <input
              id="talent-login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="performer@example.com"
              required
              className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-login-password">
              Password
            </label>
            <input
              id="talent-login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
            />
          </div>

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-fuchsia-600 px-5 py-3 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === 'submitting' ? 'Logging you in...' : 'Log in'}
          </button>
        </form>

        <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/70 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <KeyRound className="h-4 w-4 text-fuchsia-300" />
            Recovery link
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Need a fallback? Request a magic-link recovery email for an approved performer account. This stays secondary to your regular password login.
          </p>

          {recoveryMessage ? (
            <div
              className={`mt-4 rounded-2xl px-4 py-3 text-sm ${
                recoveryStatus === 'success'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                  : 'border border-rose-500/20 bg-rose-500/10 text-rose-100'
              }`}
            >
              {recoveryMessage}
            </div>
          ) : null}

          <form id="talent-login-recovery-form" className="mt-4" onSubmit={handleRecoverySubmit}>
            <button
              type="submit"
              disabled={recoveryStatus === 'submitting' || email.trim().length === 0}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-5 py-3 text-sm font-black text-fuchsia-100 transition hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {recoveryStatus === 'submitting' ? 'Sending your recovery link...' : 'Email me a secure sign-in link'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
