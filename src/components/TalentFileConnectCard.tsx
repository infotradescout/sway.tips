import { useEffect, useState } from 'react';
import { Link2, Loader2, ShieldCheck } from 'lucide-react';
import { StatusBanner } from './TalentAuthStatus';

type Preview = {
  purpose: 'request_files' | 'send_files';
  connectionLabel: string | null;
  expiresAt: string;
  creator: { displayName: string; handle: string | null };
  grantsProjectAccess: boolean;
  grantsRoomAccess: boolean;
};

function readTokenFromHash() {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  return params.get('token')?.trim() || '';
}

export default function TalentFileConnectCard() {
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<'loading' | 'needs_login' | 'ready' | 'claiming' | 'done' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const raw = readTokenFromHash();
    setToken(raw);
    if (!raw) {
      setStatus('error');
      setMessage('This pairing link is missing its private token fragment.');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/talent/audio/pairing/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: raw })
        });
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (response.status === 401) {
          setStatus('needs_login');
          setMessage('Sign in to confirm this private file connection.');
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
    if (!token || status === 'claiming') return;
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
        setMessage('Sign in to confirm this private file connection.');
        return;
      }
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to confirm pairing.');
      }
      setStatus('done');
      setMessage(
        data.reusedExisting
          ? 'You were already connected. The QR was consumed.'
          : 'Connected. Pairing grants no file access until someone shares a specific file.'
      );
      window.history.replaceState({}, '', window.location.pathname);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to confirm pairing.');
    }
  };

  const loginHref = `/talent/login?redirect=${encodeURIComponent('/talent/connect/files' + (token ? `#token=${encodeURIComponent(token)}` : ''))}`;

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto max-w-xl rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.16),_transparent_36%),linear-gradient(180deg,_rgba(15,23,42,0.98),_rgba(2,6,23,1))] p-6 shadow-2xl sm:p-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
          <Link2 className="h-5 w-5" />
        </div>
        <p className="mt-5 text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Private file connection</p>
        <h1 className="mt-2 font-display text-3xl font-black text-white">Confirm pairing</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          This is not a room QR. Confirming creates a private connection only — no project, master, or room access is granted by pairing alone.
        </p>

        {message ? (
          <StatusBanner
            tone={status === 'done' ? 'emerald' : status === 'needs_login' ? 'amber' : 'rose'}
            message={message}
          />
        ) : null}

        {status === 'loading' || status === 'claiming' ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            {status === 'claiming' ? 'Confirming…' : 'Checking pairing…'}
          </div>
        ) : null}

        {status === 'needs_login' ? (
          <a
            href={loginHref}
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-cyan-500 px-4 text-sm font-black text-slate-950 transition hover:bg-cyan-400"
          >
            Sign in to continue
          </a>
        ) : null}

        {status === 'ready' && preview ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">Connecting with</p>
              <p className="mt-2 text-lg font-black text-white">
                {preview.creator.displayName}
                {preview.creator.handle ? ` (@${preview.creator.handle})` : ''}
              </p>
              <p className="mt-2 text-sm text-slate-300">
                Purpose:{' '}
                {preview.purpose === 'request_files'
                  ? 'they want to receive files from you'
                  : 'they want to send files to you'}
              </p>
              <p className="mt-2 flex items-center gap-2 text-xs text-emerald-200/90">
                <ShieldCheck className="h-3.5 w-3.5" />
                Pairing grants no file or room access by itself
              </p>
            </div>

            <button
              type="button"
              onClick={claim}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-cyan-500 px-4 text-sm font-black text-slate-950 transition hover:bg-cyan-400"
            >
              Confirm connection
            </button>
          </div>
        ) : null}

        {status === 'done' ? (
          <a
            href="/talent"
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-2xl border border-cyan-400/40 px-4 text-sm font-black text-cyan-100 transition hover:bg-cyan-400/10"
          >
            Back to account
          </a>
        ) : null}
      </div>
    </div>
  );
}
