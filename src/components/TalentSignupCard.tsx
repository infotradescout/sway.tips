import { Lock, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';

const SUCCESS_COPY = 'Check your email to verify your Sway performer account.';

type SignupStatus = 'idle' | 'submitting' | 'success' | 'error';

export default function TalentSignupCard() {
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [status, setStatus] = useState<SignupStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const searchParams = new URLSearchParams(window.location.search);
  const signupStatus = searchParams.get('status');
  const statusMessage = signupStatus === 'invalid-link'
    ? 'That verification link is no longer valid. Log in and request a recovery link if you still need access.'
    : signupStatus === 'unavailable'
      ? 'Performer signup is temporarily unavailable. Please try again in a moment.'
      : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);

    try {
      const response = await fetch('/api/talent/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          displayName,
          handle,
          email,
          password,
          confirmPassword,
          termsAccepted
        })
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Performer signup request failed.');
      }

      setStatus('success');
      setMessage(SUCCESS_COPY);
      setDisplayName('');
      setHandle('');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setTermsAccepted(false);
    } catch (error) {
      console.warn('Unable to create performer account:', error);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'We could not create your performer account right now. Please try again in a moment.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.08fr,0.92fr]">
        <div className="rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(217,70,239,0.18),_transparent_34%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,1))] p-7 shadow-2xl">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
            <Sparkles className="h-5 w-5" />
          </div>
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-fuchsia-300">Performer Signup</p>
          <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-white">Create your Sway performer account</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Create your account with email and password, claim a unique handle, and verify your inbox before you start your first live room.
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Already have an account? <a className="font-bold text-fuchsia-300 hover:text-fuchsia-200" href="/talent/login">Log in</a>
          </p>

          {statusMessage ? (
            <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              {statusMessage}
            </div>
          ) : null}

          {message ? (
            <div
              className={`mt-5 rounded-2xl px-4 py-3 text-sm ${
                status === 'success'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                  : 'border border-rose-500/20 bg-rose-500/10 text-rose-100'
              }`}
            >
              {message}
            </div>
          ) : null}

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-signup-display-name">
                Performer Name
              </label>
              <input
                id="talent-signup-display-name"
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="DJ Sunset"
                required
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-signup-handle">
                Handle
              </label>
              <input
                id="talent-signup-handle"
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="dj-sunset"
                required
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-signup-email">
                Email
              </label>
              <input
                id="talent-signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="performer@example.com"
                required
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-signup-password">
                  Password
                </label>
                <input
                  id="talent-signup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  required
                  className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-signup-confirm-password">
                  Confirm Password
                </label>
                <input
                  id="talent-signup-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Re-enter password"
                  required
                  className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
                />
              </div>
            </div>

            <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-900 text-fuchsia-500 focus:ring-fuchsia-500"
                required
              />
              <span>
                I accept the Sway Terms and I am creating this performer account for myself.
              </span>
            </label>

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-fuchsia-600 px-5 py-3 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === 'submitting' ? 'Creating your account...' : 'Create Account'}
            </button>
          </form>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-slate-900 p-6 shadow-2xl">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
            <Lock className="h-5 w-5" />
          </div>
          <h2 className="font-display text-2xl font-black text-white">What happens next</h2>
          <div className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
            <p>We create your performer account immediately and send a short-lived verification link to your inbox.</p>
            <p>You can log in before verification, but Sway will block live-room start until your email is verified.</p>
            <p>Your verification link lands you back in the performer login flow so you can continue safely on the right device.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
