import { KeyRound, Lock, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { StatusBanner, useAuthQueryStatusMessage } from './TalentAuthStatus';

const SUCCESS_COPY = 'Check your email to verify your Sway performer account.';

// Mirrors src/server/performer-login.ts normalizePerformerHandle and
// src/server/performer-password-auth.ts PERFORMER_PASSWORD_MIN_LENGTH — keep in sync.
const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;
const PASSWORD_MIN_LENGTH = 8;

type SignupStatus = 'idle' | 'submitting' | 'success' | 'error';
type EntryMode = 'code' | 'create';

type SignupResponse = {
  error?: string;
  message?: string;
  deliveryMode?: string;
  verificationLink?: string;
  redirectPath?: string;
};

export default function TalentSignupCard() {
  const initial = useMemo(() => {
    if (typeof window === 'undefined') {
      return { mode: 'code' as EntryMode, code: '', email: '' };
    }
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code')?.trim() || '';
    const email = params.get('email')?.trim().toLowerCase() || '';
    // Code path is the top path for invite handoff. Open create only when explicitly requested.
    const mode: EntryMode = params.get('mode') === 'create' && !code ? 'create' : 'code';
    return { mode, code, email };
  }, []);

  const [mode, setMode] = useState<EntryMode>(initial.mode);
  const [claimCode, setClaimCode] = useState(initial.code);
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [status, setStatus] = useState<SignupStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [verificationLink, setVerificationLink] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const next = new URLSearchParams(params);
    if (mode === 'code') {
      next.delete('mode');
      if (claimCode) next.set('code', claimCode);
      else next.delete('code');
    } else {
      next.set('mode', 'create');
      next.delete('code');
    }
    const query = next.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
  }, [mode, claimCode]);

  const handleError = handle.length > 0 && !HANDLE_PATTERN.test(handle)
    ? 'Letters, numbers, hyphens, and underscores only.'
    : null;
  const passwordError = password.length > 0 && password.length < PASSWORD_MIN_LENGTH
    ? `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
    : null;
  const confirmPasswordError = confirmPassword.length > 0 && confirmPassword !== password
    ? 'Passwords do not match.'
    : null;

  const canClaim = Boolean(claimCode.trim())
    && email.includes('@')
    && password.length >= PASSWORD_MIN_LENGTH
    && confirmPassword === password
    && termsAccepted;

  const canCreate = displayName.trim().length > 0
    && HANDLE_PATTERN.test(handle)
    && email.trim().length > 0
    && password.length >= PASSWORD_MIN_LENGTH
    && confirmPassword === password
    && termsAccepted;

  const statusMessage = useAuthQueryStatusMessage({
    'invalid-link': 'That verification link is no longer valid. Log in and request a recovery link if you still need access.',
    unavailable: 'Performer signup is temporarily unavailable. Please try again in a moment.'
  });

  const handleClaimSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canClaim || status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);
    setVerificationLink(null);

    try {
      const response = await fetch('/api/talent/claim/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: claimCode.trim(),
          email,
          password,
          confirmPassword,
          termsAccepted
        })
      });
      const data = await response.json().catch(() => null) as SignupResponse | null;
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to claim this profile.');
      }
      window.location.assign(typeof data?.redirectPath === 'string' ? data.redirectPath : '/talent');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to claim this profile.');
    }
  };

  const handleCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);
    setVerificationLink(null);

    try {
      const response = await fetch('/api/talent/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          handle,
          email,
          password,
          confirmPassword,
          termsAccepted
        })
      });

      const data = await response.json().catch(() => null) as SignupResponse | null;
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Performer signup request failed.');
      }

      setStatus('success');
      if (data?.deliveryMode === 'mock' && typeof data.verificationLink === 'string') {
        setMessage('Local email delivery is mocked. Open the verification link below to finish setup.');
        setVerificationLink(data.verificationLink);
      } else {
        setMessage(data?.message || SUCCESS_COPY);
      }
      setDisplayName('');
      setHandle('');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setTermsAccepted(false);
    } catch (error) {
      console.warn('Unable to create performer account:', error);
      setStatus('error');
      setVerificationLink(null);
      setMessage(error instanceof Error ? error.message : 'We could not create your performer account right now. Please try again in a moment.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 pb-24 pt-8 text-slate-100 sm:pb-8">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.08fr,0.92fr]">
        <div className="rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(217,70,239,0.18),_transparent_34%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,1))] p-7 shadow-2xl">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
            {mode === 'code' ? <KeyRound className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
          </div>
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-fuchsia-300">
            {mode === 'code' ? 'Claim with code' : 'Performer Signup'}
          </p>
          <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-white">
            {mode === 'code' ? 'Enter your code' : 'Create your Sway performer account'}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {mode === 'code'
              ? 'If someone sent you a Sway code, enter it here. You skip handle setup and take over the prepared profile.'
              : 'Create your account with email and password, claim a unique handle, and verify your inbox before you start your first live room.'}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Already have an account? <a className="font-bold text-fuchsia-300 hover:text-fuchsia-200" href="/talent/login">Log in</a>
          </p>

          <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-1">
            <button
              type="button"
              onClick={() => {
                setMode('code');
                setStatus('idle');
                setMessage(null);
                setVerificationLink(null);
              }}
              className={`min-h-11 rounded-xl text-sm font-black transition ${
                mode === 'code' ? 'bg-fuchsia-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              I have a code
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('create');
                setStatus('idle');
                setMessage(null);
                setVerificationLink(null);
              }}
              className={`min-h-11 rounded-xl text-sm font-black transition ${
                mode === 'create' ? 'bg-fuchsia-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Create account
            </button>
          </div>

          {statusMessage ? <StatusBanner tone="amber" message={statusMessage} /> : null}
          {message ? <StatusBanner tone={status === 'success' ? 'emerald' : 'rose'} message={message} /> : null}
          {verificationLink ? (
            <a
              className="mt-3 block rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm font-black text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-400/15"
              href={verificationLink}
            >
              Open local verification link
            </a>
          ) : null}

          {mode === 'code' ? (
            <form className="mt-6 space-y-4" onSubmit={handleClaimSubmit}>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-claim-code">
                  Code
                </label>
                <input
                  id="talent-claim-code"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={claimCode}
                  onChange={(event) => setClaimCode(event.target.value.trim())}
                  placeholder="Paste the code you were sent"
                  required
                  className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 font-mono text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-claim-email">
                  Your email
                </label>
                <input
                  id="talent-claim-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-claim-password">
                    Password
                  </label>
                  <input
                    id="talent-claim-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="At least 8 characters"
                    required
                    aria-invalid={passwordError ? true : undefined}
                    className={`w-full rounded-2xl border bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 ${
                      passwordError
                        ? 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500'
                        : 'border-white/10 focus:border-fuchsia-500 focus:ring-fuchsia-500'
                    }`}
                  />
                  {passwordError ? <p className="text-xs text-rose-300">{passwordError}</p> : null}
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-claim-confirm-password">
                    Confirm Password
                  </label>
                  <input
                    id="talent-claim-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Re-enter password"
                    required
                    aria-invalid={confirmPasswordError ? true : undefined}
                    className={`w-full rounded-2xl border bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 ${
                      confirmPasswordError
                        ? 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500'
                        : 'border-white/10 focus:border-fuchsia-500 focus:ring-fuchsia-500'
                    }`}
                  />
                  {confirmPasswordError ? <p className="text-xs text-rose-300">{confirmPasswordError}</p> : null}
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
                <span>I accept the Sway Terms and I am taking ownership of this performer profile.</span>
              </label>

              <button
                type="submit"
                disabled={status === 'submitting' || !canClaim}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-fuchsia-600 px-5 py-3 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {status === 'submitting' ? 'Claiming profile...' : 'Claim profile'}
              </button>
            </form>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={handleCreateSubmit}>
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
                  aria-invalid={handleError ? true : undefined}
                  className={`w-full rounded-2xl border bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 ${
                    handleError
                      ? 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500'
                      : 'border-white/10 focus:border-fuchsia-500 focus:ring-fuchsia-500'
                  }`}
                />
                {handleError ? <p className="text-xs text-rose-300">{handleError}</p> : null}
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
                    aria-invalid={passwordError ? true : undefined}
                    className={`w-full rounded-2xl border bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 ${
                      passwordError
                        ? 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500'
                        : 'border-white/10 focus:border-fuchsia-500 focus:ring-fuchsia-500'
                    }`}
                  />
                  {passwordError ? <p className="text-xs text-rose-300">{passwordError}</p> : null}
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
                    aria-invalid={confirmPasswordError ? true : undefined}
                    className={`w-full rounded-2xl border bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 ${
                      confirmPasswordError
                        ? 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500'
                        : 'border-white/10 focus:border-fuchsia-500 focus:ring-fuchsia-500'
                    }`}
                  />
                  {confirmPasswordError ? <p className="text-xs text-rose-300">{confirmPasswordError}</p> : null}
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
                disabled={status === 'submitting' || !canCreate}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-fuchsia-600 px-5 py-3 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {status === 'submitting' ? 'Creating your account...' : 'Create Account'}
              </button>
            </form>
          )}
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-slate-900 p-6 shadow-2xl">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
            <Lock className="h-5 w-5" />
          </div>
          <h2 className="font-display text-2xl font-black text-white">
            {mode === 'code' ? 'Code bypass' : 'What happens next'}
          </h2>
          <div className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
            {mode === 'code' ? (
              <>
                <p>Enter the code you were sent. You do not pick a handle — the prepared profile is already set.</p>
                <p>Set your email and password, accept terms, and you land in that account immediately.</p>
                <p>No code? Switch to Create account to start a brand-new performer profile.</p>
              </>
            ) : (
              <>
                <p>We create your performer account immediately and send a short-lived verification link to your inbox.</p>
                <p>You can log in before verification, but Sway will block live-room start until your email is verified.</p>
                <p>Your verification link lands you back in the performer login flow so you can continue safely on the right device.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
