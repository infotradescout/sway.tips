import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';

const SUCCESS_COPY = 'If this email is on an approved Sway performer account, we sent a link.';

type LoginStatus = 'idle' | 'submitting' | 'success' | 'error';

export default function TalentLoginCard() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const searchParams = new URLSearchParams(window.location.search);
  const loginStatus = searchParams.get('status');
  const statusMessage = loginStatus === 'invalid-link'
    ? 'This sign-in link is no longer valid. Request a fresh one to open your performer console.'
    : (loginStatus === 'unavailable'
        ? 'Performer sign-in is temporarily unavailable. Please request a fresh link in a moment.'
        : null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    setStatus('submitting');
    setMessage(null);

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
        throw new Error('Performer login request failed.');
      }

      setStatus('success');
      setMessage(SUCCESS_COPY);
      setEmail('');
    } catch (error) {
      console.warn('Unable to request performer sign-in link:', error);
      setStatus('error');
      setMessage('We could not send a sign-in link right now. Please try again in a moment.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
          <Lock className="h-5 w-5" />
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-fuchsia-300">Performer Access</p>
        <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-white">Open your Sway performer console</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Enter the email tied to your approved performer account and we&apos;ll send a secure sign-in link for this device.
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
            <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="talent-login-email">
              Performer email
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

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-fuchsia-600 px-5 py-3 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === 'submitting' ? 'Sending your secure link...' : 'Email me a secure sign-in link'}
          </button>
        </form>
      </div>
    </div>
  );
}
