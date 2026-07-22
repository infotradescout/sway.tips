import { useEffect, useMemo, useState } from 'react';
import { Link2, Loader2, QrCode } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

type Connection = {
  connectionId: string;
  purpose: 'request_files' | 'send_files';
  connectedAt: string;
  counterparty: { displayName: string; handle: string | null } | null;
};

export default function PerformerFilePairing() {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState<'request_files' | 'send_files'>('request_files');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);

  const purposeLabel = useMemo(
    () => (purpose === 'request_files' ? 'Request files from them' : 'Send files to them'),
    [purpose]
  );

  const refreshConnections = async () => {
    const response = await fetch('/api/talent/audio/pairing/connections', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load connections.');
    setConnections(data.connections || []);
  };

  useEffect(() => {
    if (!open) return;
    refreshConnections().catch((error) => {
      setStatus(error instanceof Error ? error.message : 'Could not load connections.');
    });
  }, [open]);

  const createQr = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    setQrUrl(null);
    try {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const token = bytesToBase64Url(secret);
      const tokenHash = await sha256Hex(secret);
      const idempotencyKey = crypto.randomUUID();

      const response = await fetch('/api/talent/audio/pairing/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, tokenHash, idempotencyKey })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not create pairing QR.');

      const pairingPath = typeof data.pairingPath === 'string' ? data.pairingPath : '/talent/connect/files';
      const url = `${window.location.origin}${pairingPath}#token=${encodeURIComponent(token)}`;
      setQrUrl(url);
      setExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null);
      setStatus(`${purposeLabel}. QR expires in 15 minutes. Pairing alone grants no file access.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not create pairing QR.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (connectionId: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/pairing/connections/${connectionId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not revoke connection.');
      await refreshConnections();
      setStatus('Connection removed. Reconnecting requires a new QR.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not revoke connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-white transition hover:border-cyan-400/40"
      >
        <Link2 className="h-4 w-4" aria-hidden="true" />
        Pair for files
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-slate-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Private pairing</p>
                <h3 className="mt-1 font-display text-xl font-black text-white">Connect for file exchange</h3>
                <p className="mt-2 text-sm text-slate-400">
                  One-time QR creates a durable connection. File access still requires an explicit share afterward.
                </p>
              </div>
              <button type="button" className="text-slate-400 hover:text-white" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setPurpose('request_files')}
                className={`min-h-11 rounded-xl border px-3 text-sm font-bold ${
                  purpose === 'request_files'
                    ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                    : 'border-white/10 text-slate-300'
                }`}
              >
                Request files
              </button>
              <button
                type="button"
                onClick={() => setPurpose('send_files')}
                className={`min-h-11 rounded-xl border px-3 text-sm font-bold ${
                  purpose === 'send_files'
                    ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                    : 'border-white/10 text-slate-300'
                }`}
              >
                Send files
              </button>
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={createQr}
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 text-sm font-black text-slate-950 transition hover:bg-cyan-400 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              Show pairing QR
            </button>

            {qrUrl ? (
              <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4">
                <QRCodeCanvas value={qrUrl} size={196} bgColor="#020617" fgColor="#ecfeff" includeMargin />
                <p className="text-center text-xs text-cyan-100/80">{purposeLabel}</p>
                {expiresAt ? (
                  <p className="text-center text-[11px] text-slate-400">
                    Expires {new Date(expiresAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            ) : null}

            {status ? <p className="mt-3 text-sm text-slate-300">{status}</p> : null}

            <div className="mt-5 space-y-2">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">Active connections</p>
              {connections.length === 0 ? (
                <p className="text-sm text-slate-500">None yet.</p>
              ) : (
                connections.map((connection) => (
                  <div
                    key={connection.connectionId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-bold text-white">
                        {connection.counterparty?.displayName || 'Connected account'}
                        {connection.counterparty?.handle ? ` @${connection.counterparty.handle}` : ''}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {connection.purpose === 'request_files' ? 'Opened as request' : 'Opened as send'} ·{' '}
                        {new Date(connection.connectedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => revoke(connection.connectionId)}
                      className="shrink-0 rounded-lg border border-rose-400/30 px-2 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-400/10"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
