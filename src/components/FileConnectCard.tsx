import { useEffect, useState, type MouseEvent } from 'react';
import { Link2, Loader2, ShieldCheck } from 'lucide-react';
import { StatusBanner } from './TalentAuthStatus';
import {
  buildFileConnectLoginHref,
  FILE_COLLABORATION_PATHS,
  readFilePairingTokenFromHash
} from '../file-collaboration-routing';

type Preview = {
  purpose: 'request_files' | 'send_files';
  connectionLabel: string | null;
  expiresAt: string;
  creator: { displayName: string; handle: string | null };
  grantsProjectAccess: boolean;
  grantsRoomAccess: boolean;
};

type ConnectStatus = 'checking_account' | 'needs_login' | 'loading' | 'ready' | 'claiming' | 'done' | 'error';

export type FileConnectAccountIdentity = {
  label: string;
  email: string | null;
};

export function resolveFileConnectAccountIdentity(value: unknown): FileConnectAccountIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const account = value as { displayName?: unknown; email?: unknown };
  const displayName = typeof account.displayName === 'string' ? account.displayName.trim() : '';
  const email = typeof account.email === 'string' ? account.email.trim() : '';
  if (!displayName && !email) return null;
  return {
    label: displayName || email,
    email: displayName && email ? email : null
  };
}

export default function FileConnectCard() {
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accountIdentity, setAccountIdentity] = useState<FileConnectAccountIdentity | null>(null);
  const [status, setStatus] = useState<ConnectStatus>('checking_account');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const raw = readFilePairingTokenFromHash(window.location.hash);
    setToken(raw);
    if (!raw) {
      setStatus('error');
      setMessage('This pairing link is missing a valid private token fragment. Scan a fresh file QR.');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const sessionResponse = await fetch('/api/account/session', { cache: 'no-store' });
        const sessionData = await sessionResponse.json().catch(() => ({}));
        if (cancelled) return;
        if (sessionResponse.status === 401) {
          setStatus('needs_login');
          setMessage('Sign in with an existing verified Sway account to confirm this private file connection.');
          return;
        }
        if (!sessionResponse.ok) {
          setStatus('error');
          setMessage(typeof sessionData?.error === 'string' ? sessionData.error : 'Account access is temporarily unavailable.');
          return;
        }
        const identity = resolveFileConnectAccountIdentity(sessionData?.account);
        if (!identity) {
          setStatus('error');
          setMessage('Unable to confirm which Sway account is signed in.');
          return;
        }
        setAccountIdentity(identity);

        setStatus('loading');
        const response = await fetch('/api/talent/audio/pairing/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: raw })
        });
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (response.status === 401) {
          setStatus('needs_login');
          setMessage('Your session ended. Sign in again to confirm this private file connection.');
          return;
        }
        if (!response.ok) {
          setStatus('error');
          setMessage(typeof data?.error === 'string' ? data.error : 'Unable to open this pairing QR.');
          return;
        }
        setPreview(data as Preview);
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('error');
          setMessage('Unable to open this pairing QR.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const claim = async () => {
    if (!token || !accountIdentity || status === 'claiming') return;
    setStatus('claiming');
    setMessage(null);
    try {
      const response = await fetch('/api/talent/audio/pairing/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setStatus('needs_login');
        setMessage('Your session ended. Sign in again to confirm this private file connection.');
        return;
      }
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to confirm pairing.');
      }
      setStatus('done');
      setMessage(
        data.reusedExisting
          ? 'You were already connected. The one-time QR is now consumed.'
          : 'Connected. Pairing grants no file access until someone shares a specific file.'
      );
      window.location.replace(FILE_COLLABORATION_PATHS.inbox);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to confirm pairing.');
    }
  };

  const loginHref = buildFileConnectLoginHref(typeof window === 'undefined' ? '' : window.location.hash);
  const replaceFileConnectExit = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.location.replace(event.currentTarget.href);
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto max-w-xl rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.16),_transparent_36%),linear-gradient(180deg,_rgba(15,23,42,0.98),_rgba(2,6,23,1))] p-6 shadow-2xl sm:p-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
          <Link2 className="h-5 w-5" aria-hidden />
        </div>
        <p className="mt-5 text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Private file connection</p>
        <h1 className="mt-2 font-display text-3xl font-black text-white">Confirm connection</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          This is not a Live Room QR. Confirming creates a private account connection only. It grants no project, master, or room access by itself.
        </p>

        {message ? (
          <div role="status" aria-live="polite">
            <StatusBanner
              tone={status === 'done' ? 'emerald' : status === 'needs_login' ? 'amber' : 'rose'}
              message={message}
            />
          </div>
        ) : null}

        {status === 'checking_account' || status === 'loading' || status === 'claiming' ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {status === 'claiming' ? 'Confirming…' : status === 'checking_account' ? 'Checking your account…' : 'Checking pairing…'}
          </div>
        ) : null}

        {status === 'needs_login' ? (
          <div className="mt-6 space-y-3">
            <button type="button" onClick={() => window.location.replace(loginHref)} className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-cyan-500 px-4 text-sm font-black text-slate-950 transition hover:bg-cyan-400">
              Sign in to continue
            </button>
            <p className="text-center text-xs leading-5 text-slate-400">
              New to Sway? <a href="/account/signup" onClick={replaceFileConnectExit} className="font-bold text-cyan-300">Create and verify your account</a>, then rescan this QR. The private token is never placed in a query string or saved in browser storage.
            </p>
          </div>
        ) : null}

        {status === 'ready' && preview && accountIdentity ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4">
              <p className="text-sm text-amber-100">
                Connecting as <span className="font-black text-white">{accountIdentity.label}</span>
              </p>
              {accountIdentity.email ? (
                <p className="mt-1 text-xs text-amber-100/75">{accountIdentity.email}</p>
              ) : null}
              <p className="mt-2 text-xs leading-5 text-amber-100/75">
                Confirm only if this is the account that should claim this one-time QR.
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">Connecting with</p>
              <p className="mt-2 text-lg font-black text-white">
                {preview.creator.displayName}
                {preview.creator.handle ? ` (@${preview.creator.handle})` : ''}
              </p>
              <p className="mt-2 text-sm text-slate-300">
                {preview.purpose === 'request_files'
                  ? 'They are requesting files. Only a performer with Catalog access can select and share a file after pairing.'
                  : 'They intend to share selected files with you after pairing.'}
              </p>
              <p className="mt-2 flex items-center gap-2 text-xs text-emerald-200/90">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Pairing grants no file or room access by itself
              </p>
            </div>

            <button type="button" onClick={() => { void claim(); }} className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-cyan-500 px-4 text-sm font-black text-slate-950 transition hover:bg-cyan-400">
              Confirm connection
            </button>
          </div>
        ) : null}

        {status === 'done' ? (
          <a href={FILE_COLLABORATION_PATHS.inbox} onClick={replaceFileConnectExit} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-2xl border border-cyan-400/40 px-4 text-sm font-black text-cyan-100 transition hover:bg-cyan-400/10">
            Open Collaborator Inbox
          </a>
        ) : null}

        {status === 'error' ? (
          <a href={FILE_COLLABORATION_PATHS.inbox} onClick={replaceFileConnectExit} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-2xl border border-white/10 px-4 text-sm font-black text-slate-200">
            Back to Collaborator Inbox
          </a>
        ) : null}
      </div>
    </div>
  );
}
