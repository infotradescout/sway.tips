import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, LogOut, QrCode, Radio, ShieldCheck, UserRound } from 'lucide-react';
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

type ClaimPreview = {
  displayName: string;
  handle: string | null;
  enablesProMode: true;
};

type ClaimValidationState = 'idle' | 'loading' | 'valid' | 'invalid';

async function accountJson(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  } : { cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || 'That action failed.'), { status: response.status, code: data?.code });
  return data;
}

function readClaimFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('claim') || params.get('code') || '').trim();
}

function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[100dvh] overflow-y-auto overflow-x-hidden bg-slate-950 px-4 py-8 text-white sm:py-10">
      <AppBackdrop />
      <div className="relative mx-auto w-full max-w-md rounded-3xl border border-white/10 bg-slate-900/90 p-5 shadow-2xl backdrop-blur sm:p-6">
        {children}
      </div>
    </div>
  );
}

function ClaimCodeField(props: {
  value: string;
  onChange: (value: string) => void;
  validation: ClaimValidationState;
  preview: ClaimPreview | null;
  error: string | null;
  onBlurValidate: () => void;
  disabled?: boolean;
}) {
  const fieldId = useId();
  const helpId = useId();
  const statusId = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={fieldId} className="block text-xs font-bold text-slate-200">Claim code (optional)</label>
      <input
        id={fieldId}
        name="claimCode"
        autoComplete="one-time-code"
        inputMode="text"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onBlurValidate}
        placeholder="Enter claim code"
        aria-describedby={`${helpId} ${statusId}`}
        aria-invalid={props.validation === 'invalid'}
        aria-busy={props.validation === 'loading'}
        className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm outline-none ring-fuchsia-400/40 focus:ring-2"
      />
      <p id={helpId} className="text-[11px] leading-5 text-slate-400">
        Have a performer profile waiting for you? Enter the code to claim it.
      </p>
      <div id={statusId} role="status" aria-live="polite" className="min-h-[1.25rem]">
        {props.validation === 'loading' ? (
          <p className="text-xs text-slate-400">Checking claim code…</p>
        ) : null}
        {props.validation === 'valid' && props.preview ? (
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-3 text-xs leading-5 text-emerald-100">
            <p className="inline-flex items-center gap-1.5 font-bold">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              Performer profile found: {props.preview.displayName}
            </p>
            <p className="mt-1 text-emerald-100/90">This account will claim that profile and activate Pro Mode.</p>
          </div>
        ) : null}
        {props.validation === 'invalid' && props.error ? (
          <p className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-3 py-3 text-xs leading-5 text-rose-100">{props.error}</p>
        ) : null}
      </div>
    </div>
  );
}

export function AccountLogin() {
  const params = new URLSearchParams(window.location.search);
  const initialClaim = readClaimFromLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [claimCode, setClaimCode] = useState(initialClaim);
  const [message, setMessage] = useState(params.get('verified') === '1' ? 'Email verified. Log in to continue.' : '');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const data = await accountJson('/api/account/login', {
        email,
        password,
        claimCode: claimCode.trim() || undefined
      });
      window.location.assign(data.redirectPath || '/account');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to log in.');
    } finally {
      setPending(false);
    }
  };

  const signupHref = claimCode.trim()
    ? `/account/signup?claim=${encodeURIComponent(claimCode.trim())}`
    : '/account/signup';

  return (
    <AccessFrame>
      <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">One Sway account</p>
      <h1 className="mt-2 font-display text-3xl font-black">Log in</h1>
      <p className="mt-2 text-sm text-slate-400">Join rooms as a customer or open Pro Mode from the same account.</p>
      {claimCode.trim() ? (
        <p className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">
          After login, Sway will continue your claim for the pending performer profile.
        </p>
      ) : null}
      {message ? <p className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">{message}</p> : null}
      <form onSubmit={submit} className="mt-5 space-y-3">
        <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm" />
        {claimCode.trim() ? (
          <input type="hidden" name="claimCode" value={claimCode.trim()} />
        ) : null}
        <button disabled={pending} className="min-h-12 w-full rounded-xl bg-fuchsia-600 px-4 text-sm font-black disabled:opacity-60">{pending ? 'Logging in…' : 'Log in'}</button>
      </form>
      <a href={signupHref} className="mt-4 block text-center text-sm font-bold text-cyan-300">Create an account</a>
    </AccessFrame>
  );
}

export function AccountSignup() {
  const initialClaim = readClaimFromLocation();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [claimCode, setClaimCode] = useState(initialClaim);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const [verificationLink, setVerificationLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [claimValidation, setClaimValidation] = useState<ClaimValidationState>(initialClaim ? 'loading' : 'idle');
  const [claimPreview, setClaimPreview] = useState<ClaimPreview | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const validateSeq = useRef(0);

  const validateClaim = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setClaimValidation('idle');
      setClaimPreview(null);
      setClaimError(null);
      return;
    }
    const seq = ++validateSeq.current;
    setClaimValidation('loading');
    setClaimError(null);
    try {
      const data = await accountJson('/api/account/claim/peek', { code: trimmed });
      if (seq !== validateSeq.current) return;
      setClaimPreview({
        displayName: String(data.displayName || 'Performer'),
        handle: typeof data.handle === 'string' ? data.handle : null,
        enablesProMode: true
      });
      setClaimValidation('valid');
    } catch (error: any) {
      if (seq !== validateSeq.current) return;
      setClaimPreview(null);
      setClaimValidation('invalid');
      setClaimError(error instanceof Error ? error.message : 'Code not recognized');
    }
  }, []);

  useEffect(() => {
    if (initialClaim) void validateClaim(initialClaim);
  }, [initialClaim, validateClaim]);

  const loginHref = useMemo(() => {
    const trimmed = claimCode.trim();
    return trimmed ? `/account/login?claim=${encodeURIComponent(trimmed)}` : '/account/login';
  }, [claimCode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      if (password !== confirmPassword) {
        setMessage('Password confirmation does not match.');
        return;
      }
      const trimmedClaim = claimCode.trim();
      if (trimmedClaim) {
        if (claimValidation === 'invalid') {
          setMessage(claimError || 'Remove the claim code or enter a valid one to continue.');
          return;
        }
        if (claimValidation !== 'valid') {
          await validateClaim(trimmedClaim);
          // Re-check via a fresh peek result stored in refs is awkward; block if still not valid after await.
          // validateClaim updates state asynchronously for next paint — call peek inline for submit gate.
          try {
            await accountJson('/api/account/claim/peek', { code: trimmedClaim });
          } catch (error) {
            setClaimValidation('invalid');
            setClaimError(error instanceof Error ? error.message : 'Code not recognized');
            setMessage(error instanceof Error ? error.message : 'Remove the claim code or enter a valid one to continue.');
            return;
          }
          setClaimValidation('valid');
        }
      }
      const data = await accountJson('/api/account/signup', {
        displayName,
        email,
        password,
        confirmPassword,
        termsAccepted,
        claimCode: trimmedClaim || undefined
      });
      if (typeof data.redirectPath === 'string' && data.redirectPath) {
        window.location.assign(data.redirectPath);
        return;
      }
      setMessage(data.message || 'Check your email to verify your Sway account.');
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
        <ClaimCodeField
          value={claimCode}
          onChange={(value) => {
            setClaimCode(value);
            if (!value.trim()) {
              setClaimValidation('idle');
              setClaimPreview(null);
              setClaimError(null);
            } else if (claimValidation === 'valid' || claimValidation === 'invalid') {
              setClaimValidation('idle');
              setClaimPreview(null);
              setClaimError(null);
            }
          }}
          validation={claimValidation}
          preview={claimPreview}
          error={claimError}
          onBlurValidate={() => { void validateClaim(claimCode); }}
          disabled={pending}
        />
        <label className="flex gap-2 text-xs leading-5 text-slate-300">
          <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
          <span>I accept the Sway Terms.</span>
        </label>
        <button disabled={pending || !termsAccepted} className="min-h-12 w-full rounded-xl bg-fuchsia-600 px-4 text-sm font-black disabled:opacity-60">{pending ? 'Creating…' : 'Create account'}</button>
      </form>
      <a href={loginHref} className="mt-4 block text-center text-sm font-bold text-cyan-300">Already have an account?</a>
    </AccessFrame>
  );
}

export function AccountHome() {
  const pendingClaim = readClaimFromLocation();
  const [session, setSession] = useState<AccountSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [claimPreview, setClaimPreview] = useState<ClaimPreview | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);

  const load = async () => {
    try {
      const data = await accountJson('/api/account/session');
      setSession(data);
      setDisplayName(data.account?.displayName || '');
    } catch (error: any) {
      if (error?.status === 401) {
        const next = pendingClaim
          ? `/account/login?claim=${encodeURIComponent(pendingClaim)}`
          : '/account/login';
        window.location.replace(next);
      } else setMessage(error instanceof Error ? error.message : 'Unable to load account.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!pendingClaim) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await accountJson('/api/account/claim/peek', { code: pendingClaim });
        if (cancelled) return;
        setClaimPreview({
          displayName: String(data.displayName || 'Performer'),
          handle: typeof data.handle === 'string' ? data.handle : null,
          enablesProMode: true
        });
        setClaimError(null);
      } catch (error) {
        if (cancelled) return;
        setClaimPreview(null);
        setClaimError(error instanceof Error ? error.message : 'Code not recognized');
      }
    })();
    return () => { cancelled = true; };
  }, [pendingClaim]);

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

  const confirmClaim = async () => {
    if (!pendingClaim) return;
    setClaimBusy(true);
    setMessage('');
    try {
      const data = await accountJson('/api/account/claim/attach', { claimCode: pendingClaim });
      setMessage(data.message || 'Profile claimed. Pro Mode is active on this account.');
      window.history.replaceState({}, '', '/account');
      setClaimPreview(null);
      await load();
      if (typeof data.redirectPath === 'string' && data.redirectPath !== '/account') {
        window.location.assign(data.redirectPath);
      }
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : 'Unable to claim this profile.');
    } finally {
      setClaimBusy(false);
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
      {pendingClaim ? (
        <div className="mt-4 rounded-2xl border border-cyan-500/25 bg-cyan-500/10 p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">Claim confirmation</p>
          {claimPreview ? (
            <p className="mt-2 text-sm leading-6 text-cyan-50">
              Attach <span className="font-black">{claimPreview.displayName}</span> to this account and activate Pro Mode?
            </p>
          ) : (
            <p className="mt-2 text-sm text-cyan-50/90">{claimError || 'Checking claim code…'}</p>
          )}
          {claimError && claimPreview === null ? null : (
            <button
              type="button"
              disabled={claimBusy || !claimPreview}
              onClick={() => { void confirmClaim(); }}
              className="mt-3 min-h-11 w-full rounded-xl bg-cyan-500 px-4 text-sm font-black text-slate-950 disabled:opacity-60"
            >
              {claimBusy ? 'Claiming…' : 'Claim profile on this account'}
            </button>
          )}
        </div>
      ) : null}
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
