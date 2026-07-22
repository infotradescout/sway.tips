import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, LogOut, QrCode, Radio, ShieldCheck, UserRound } from 'lucide-react';
import AppBackdrop from './AppBackdrop';

type AccountSession = {
  account: {
    id: string;
    email: string | null;
    displayName: string | null;
    emailVerifiedAt: string | null;
    proModeStatus: 'disabled' | 'onboarding' | 'active' | 'suspended' | 'revoked';
  };
  performer: { id: string; displayName: string; handle: string | null; payoutsEnabled: boolean } | null;
};

async function accountJson(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  } : { cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || 'That action failed.'), { status: response.status });
  return data;
}

function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-screen overflow-hidden bg-slate-950 px-4 py-10 text-white">
      <AppBackdrop />
      <div className="relative mx-auto w-full max-w-md rounded-3xl border border-white/10 bg-slate-900/90 p-6 shadow-2xl backdrop-blur">{children}</div>
    </div>
  );
}

export function AccountLogin() {
  const params = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(params.get('verified') === '1' ? 'Email verified. Log in to continue.' : '');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const data = await accountJson('/api/account/login', { email, password });
      window.location.assign(data.redirectPath || '/account');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to log in.');
    } finally {
      setPending(false);
    }
  };

  return (
    <AccessFrame>
      <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">One Sway account</p>
      <h1 className="mt-2 font-display text-3xl font-black">Log in</h1>
      <p className="mt-2 text-sm text-slate-400">Join rooms as a customer or open Pro Mode from the same account.</p>
      {message ? <p className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">{message}</p> : null}
      <form onSubmit={submit} className="mt-5 space-y-3">
        <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <button disabled={pending} className="min-h-12 w-full rounded-xl bg-fuchsia-600 px-4 text-sm font-black disabled:opacity-60">{pending ? 'Logging in…' : 'Log in'}</button>
      </form>
      <a href="/account/signup" className="mt-4 block text-center text-sm font-bold text-cyan-300">Create an account</a>
    </AccessFrame>
  );
}

export function AccountSignup() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const [verificationLink, setVerificationLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const data = await accountJson('/api/account/signup', { displayName, email, password, confirmPassword, termsAccepted });
      setMessage(data.message);
      setVerificationLink(typeof data.verificationLink === 'string' ? data.verificationLink : null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to create account.');
    } finally {
      setPending(false);
    }
  };

  return (
    <AccessFrame>
      <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Customer or performer</p>
      <h1 className="mt-2 font-display text-3xl font-black">Create your Sway account</h1>
      <p className="mt-2 text-sm text-slate-400">Start as a customer. Activate Pro Mode whenever you are ready to perform.</p>
      {message ? <p className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">{message}</p> : null}
      {verificationLink ? <a href={verificationLink} className="mt-3 block text-xs font-bold text-cyan-300 underline">Open local verification link</a> : null}
      <form onSubmit={submit} className="mt-5 space-y-3">
        <input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <input type="password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm password" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <label className="flex gap-2 text-xs leading-5 text-slate-300"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} /><span>I accept the Sway Terms.</span></label>
        <button disabled={pending || !termsAccepted} className="min-h-12 w-full rounded-xl bg-fuchsia-600 px-4 text-sm font-black disabled:opacity-60">{pending ? 'Creating…' : 'Create account'}</button>
      </form>
      <a href="/account/login" className="mt-4 block text-center text-sm font-bold text-cyan-300">Already have an account?</a>
    </AccessFrame>
  );
}

export function AccountHome() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  const load = async () => {
    try {
      const data = await accountJson('/api/account/session');
      setSession(data);
      setDisplayName(data.account?.displayName || '');
    } catch (error: any) {
      if (error?.status === 401) window.location.replace('/account/login');
      else setMessage(error instanceof Error ? error.message : 'Unable to load account.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const activate = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      await accountJson('/api/account/pro-mode/activate', { displayName, handle });
      await load();
      setMessage('Pro Mode is active. Your performer console is ready.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to activate Pro Mode.');
    } finally {
      setPending(false);
    }
  };

  const logout = async () => {
    await accountJson('/api/account/logout', {});
    window.location.assign('/');
  };

  if (loading) return <AccessFrame><p className="text-sm text-slate-300">Loading your Sway account…</p></AccessFrame>;
  return (
    <AccessFrame>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your Sway</p>
          <h1 className="mt-2 font-display text-2xl font-black">{session?.account.displayName || 'Account'}</h1>
          <p className="mt-1 text-xs text-slate-400">{session?.account.email}</p>
        </div>
        <button onClick={logout} className="rounded-xl border border-white/10 bg-slate-950 p-3 text-slate-300" aria-label="Log out"><LogOut className="h-4 w-4" /></button>
      </div>
      {message ? <p className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">{message}</p> : null}
      <div className="mt-5 grid gap-3">
        <a href="/home" className="flex min-h-14 items-center justify-between rounded-xl bg-fuchsia-600 px-4 text-sm font-black"><span className="inline-flex items-center gap-2"><QrCode className="h-4 w-4" /> Join or scan a room</span><ArrowRight className="h-4 w-4" /></a>
        <a href="/account/reviews" className="flex min-h-14 items-center justify-between rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 text-sm font-black text-violet-100"><span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Review release rights</span><ArrowRight className="h-4 w-4" /></a>
        {session?.performer ? (
          <a href="/talent" className="flex min-h-14 items-center justify-between rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100"><span className="inline-flex items-center gap-2"><Radio className="h-4 w-4" /> Open performer console</span><ArrowRight className="h-4 w-4" /></a>
        ) : (
          <form onSubmit={activate} className="rounded-2xl border border-cyan-500/20 bg-slate-950 p-4">
            <div className="flex items-center gap-2"><UserRound className="h-4 w-4 text-cyan-300" /><h2 className="font-black">Activate Pro Mode</h2></div>
            <p className="mt-2 text-xs leading-5 text-slate-400">Create your performer identity, start rooms, share your QR, run requests, and receive earnings from this same account.</p>
            <input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Performer name" className="mt-4 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm" />
            <input required value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="Your handle" className="mt-3 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm" />
            <button disabled={pending} className="mt-3 min-h-11 w-full rounded-xl bg-cyan-500 px-4 text-sm font-black text-slate-950 disabled:opacity-60">{pending ? 'Activating…' : 'Activate Pro Mode'}</button>
          </form>
        )}
      </div>
    </AccessFrame>
  );
}
