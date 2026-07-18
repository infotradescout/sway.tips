import { KeyRound, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { StatusBanner } from './TalentAuthStatus';

const PASSWORD_MIN_LENGTH = 8;

export default function TalentInviteAcceptCard() {
  const setupContext = useMemo(() => {
    if (typeof window === 'undefined') return { token: '', isReset: false };
    const params = new URLSearchParams(window.location.search);
    return {
      token: params.get('token')?.trim() || '',
      isReset: params.get('mode') === 'reset'
    };
  }, []);
  const { token, isReset } = setupContext;
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const canSubmit = Boolean(token)
    && password.length >= PASSWORD_MIN_LENGTH
    && password === confirmPassword
    && (isReset || termsAccepted);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);
    try {
      const response = await fetch(isReset ? '/api/talent/password-reset/accept' : '/api/talent/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword, termsAccepted: isReset ? undefined : termsAccepted })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to finish account setup.');
      }
      window.location.assign(typeof data?.redirectPath === 'string' ? data.redirectPath : '/talent');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to finish account setup.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto max-w-xl rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.16),_transparent_36%),linear-gradient(180deg,_rgba(15,23,42,0.98),_rgba(2,6,23,1))] p-6 shadow-2xl sm:p-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
          <KeyRound className="h-5 w-5" />
        </div>
        <p className="mt-5 text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">{isReset ? 'One-time owner reset' : 'One-time performer invitation'}</p>
        <h1 className="mt-2 font-display text-3xl font-black text-white">Choose your own password</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          This secure link can be used once. Sway administrators cannot choose your password{isReset ? '.' : ' or accept account terms for you.'}
        </p>

        {!token ? <StatusBanner tone="rose" message="This invitation link is missing its one-time token." /> : null}
        {message ? <StatusBanner tone="rose" message={message} /> : null}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <label className="block space-y-1.5">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="min-h-12 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              className="min-h-12 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
            />
            {confirmPassword && confirmPassword !== password ? <span className="text-xs text-rose-300">Passwords do not match.</span> : null}
          </label>

          {!isReset ? (
            <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4 text-sm leading-6 text-slate-300">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                required
                className="mt-1 h-4 w-4"
              />
              <span>I accept the Sway account terms and confirm that I control this performer account.</span>
            </label>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit || status === 'submitting'}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 to-fuchsia-600 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ShieldCheck className="h-4 w-4" />
            {status === 'submitting' ? 'Finishing setup...' : 'Finish secure setup'}
          </button>
        </form>
      </div>
    </div>
  );
}
