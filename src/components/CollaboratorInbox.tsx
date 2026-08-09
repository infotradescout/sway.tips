import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Link2,
  Loader2,
  MessageSquare,
  RefreshCw,
  UserRound,
  X
} from 'lucide-react';
import AppBackdrop from './AppBackdrop';

export type FileConnection = {
  connectionId: string;
  purpose?: 'request_files' | 'send_files';
  connectedAt?: string;
  counterparty: { displayName: string; handle: string | null } | null;
};

export type CollaboratorFile = {
  grantId: string;
  connectionId: string;
  projectTitle: string;
  versionId: string;
  originalFilename: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  canDownloadOriginal: boolean;
  canComment: boolean;
  canApprove: boolean;
};

type ReviewEvent = {
  id: string;
  eventType: string;
  body: string | null;
  timecodeMs: number | null;
  createdAt: string;
};

type CollaboratorInboxProps = {
  embedded?: boolean;
  refreshKey?: number;
  onConnectionsLoaded?: (connections: FileConnection[]) => void;
};

class CollaborationRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readCollaborationResponse(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CollaborationRequestError(
      typeof data?.error === 'string' ? data.error : fallback,
      response.status
    );
  }
  return data;
}

export function describeCollaboratorFilePermissions(file: Pick<CollaboratorFile, 'canDownloadOriginal' | 'canComment' | 'canApprove'>) {
  const permissions = [];
  if (file.canDownloadOriginal) permissions.push('Source download');
  if (file.canComment) permissions.push('Review notes and change requests');
  if (file.canApprove) permissions.push('Approval');
  return permissions.length ? permissions.join(' · ') : 'Metadata only';
}

function counterpartyLabel(connection: FileConnection | undefined) {
  if (!connection?.counterparty) return 'Connected account';
  return connection.counterparty.handle
    ? `${connection.counterparty.displayName} (@${connection.counterparty.handle})`
    : connection.counterparty.displayName;
}

export default function CollaboratorInbox({
  embedded = false,
  refreshKey = 0,
  onConnectionsLoaded
}: CollaboratorInboxProps) {
  const [connections, setConnections] = useState<FileConnection[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<CollaboratorFile[]>([]);
  const [sharedByMe, setSharedByMe] = useState<CollaboratorFile[]>([]);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [reviewsByGrant, setReviewsByGrant] = useState<Record<string, ReviewEvent[]>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingGrantRevoke, setPendingGrantRevoke] = useState<string | null>(null);
  const [pendingConnectionRevoke, setPendingConnectionRevoke] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    const params = new URLSearchParams({ next: '/account/collaboration' });
    window.location.replace(`/account/login?${params.toString()}`);
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      const responses = await Promise.all([
        fetch('/api/talent/audio/pairing/connections', { cache: 'no-store' }),
        fetch('/api/talent/audio/files/shared-with-me', { cache: 'no-store' }),
        fetch('/api/talent/audio/files/shared-by-me', { cache: 'no-store' })
      ]);
      if (responses.some((response) => response.status === 401)) {
        redirectToLogin();
        return;
      }
      const [connectionsData, incomingData, outgoingData] = await Promise.all([
        readCollaborationResponse(responses[0], 'Could not load file connections.'),
        readCollaborationResponse(responses[1], 'Could not load files shared with you.'),
        readCollaborationResponse(responses[2], 'Could not load files you shared.')
      ]);
      const nextConnections = Array.isArray(connectionsData.connections)
        ? connectionsData.connections as FileConnection[]
        : [];
      setConnections(nextConnections);
      setSharedWithMe(Array.isArray(incomingData.files) ? incomingData.files : []);
      setSharedByMe(Array.isArray(outgoingData.files) ? outgoingData.files : []);
      onConnectionsLoaded?.(nextConnections);
    } catch (error) {
      if (error instanceof CollaborationRequestError && error.status === 401) {
        redirectToLogin();
        return;
      }
      setStatus(error instanceof Error ? error.message : 'Private file collaboration is temporarily unavailable.');
    } finally {
      setBusy(false);
    }
  }, [onConnectionsLoaded, redirectToLogin]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const loadReviews = async (grantId: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/file-grants/${grantId}/reviews`, { cache: 'no-store' });
      const data = await readCollaborationResponse(response, 'Could not load review activity.');
      setReviewsByGrant((current) => ({
        ...current,
        [grantId]: Array.isArray(data.events) ? data.events : []
      }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not load review activity.');
    } finally {
      setBusy(false);
    }
  };

  const sendReview = async (grantId: string, eventType: 'comment' | 'approved' | 'changes_requested') => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/file-grants/${grantId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, body: reviewDrafts[grantId]?.trim() || undefined })
      });
      await readCollaborationResponse(response, 'Could not record review.');
      setReviewDrafts((current) => ({ ...current, [grantId]: '' }));
      await loadReviews(grantId);
      setStatus(eventType === 'approved' ? 'Approval recorded.' : 'Review note recorded.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not record review.');
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = async (grantId: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/file-grants/${grantId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Removed from Collaborator Inbox.' })
      });
      await readCollaborationResponse(response, 'Could not revoke file access.');
      setPendingGrantRevoke(null);
      await refresh();
      setStatus('File access revoked. Future download and review attempts are now denied.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not revoke file access.');
    } finally {
      setBusy(false);
    }
  };

  const revokeConnection = async (connectionId: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/pairing/connections/${connectionId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Removed from Collaborator Inbox.' })
      });
      await readCollaborationResponse(response, 'Could not remove this connection.');
      setPendingConnectionRevoke(null);
      await refresh();
      setStatus('Connection removed. Its active file grants were revoked too.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not remove this connection.');
    } finally {
      setBusy(false);
    }
  };

  const renderReviewHistory = (grantId: string) => {
    const events = reviewsByGrant[grantId];
    if (!events) return null;
    return (
      <div className="mt-3 space-y-2 border-t border-white/10 pt-3" aria-label="Review history">
        {events.length === 0 ? (
          <p className="text-xs text-slate-500">No review activity yet.</p>
        ) : events.map((event) => (
          <p key={event.id} className="text-xs text-slate-300">
            <span className="font-bold capitalize text-white">{event.eventType.replaceAll('_', ' ')}</span>
            {event.body ? ` · ${event.body}` : ''}
          </p>
        ))}
      </div>
    );
  };

  const inbox = (
    <section className={embedded ? 'mt-5 rounded-2xl border border-violet-500/20 bg-slate-900/70 p-4' : ''} aria-labelledby="collaborator-inbox-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-300">Private collaboration</p>
          <h1 id="collaborator-inbox-heading" className={`${embedded ? 'text-xl' : 'text-3xl'} mt-2 font-display font-black text-white`}>Collaborator Inbox</h1>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Connections are private introductions. A connection grants no project, file, or room access until a specific immutable file version is shared.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void refresh(); }}
          disabled={busy}
          aria-label="Refresh Collaborator Inbox"
          className="rounded-xl border border-white/10 bg-slate-950 p-3 text-slate-300 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
        </button>
      </div>

      {status ? (
        <p role="status" aria-live="polite" className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">
          {status}
        </p>
      ) : null}

      <div className="mt-5 space-y-3">
        <div className="flex items-center gap-2 text-violet-200">
          <Link2 className="h-4 w-4" aria-hidden />
          <h2 className="text-xs font-black uppercase tracking-[0.2em]">Connections</h2>
        </div>
        {connections.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-xs text-slate-500">
            No file connections yet. Scan a creator's private file QR to connect.
          </p>
        ) : connections.map((connection) => (
          <article key={connection.connectionId} className="rounded-xl border border-white/10 bg-slate-950 p-3">
            <p className="text-sm font-bold text-white">{counterpartyLabel(connection)}</p>
            <p className="mt-1 text-[11px] text-slate-400">Connected account · no access granted by pairing alone</p>
            {pendingConnectionRevoke === connection.connectionId ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2">
                <p className="mr-auto text-xs text-rose-100">Remove this connection and revoke every active file grant?</p>
                <button type="button" onClick={() => setPendingConnectionRevoke(null)} className="min-h-9 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">Cancel</button>
                <button type="button" onClick={() => { void revokeConnection(connection.connectionId); }} disabled={busy} className="min-h-9 rounded-lg bg-rose-500 px-3 text-xs font-black text-white disabled:opacity-50">Remove connection</button>
              </div>
            ) : (
              <button type="button" onClick={() => setPendingConnectionRevoke(connection.connectionId)} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">
                <X className="h-3.5 w-3.5" aria-hidden />
                Remove connection
              </button>
            )}
          </article>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        <div className="flex items-center gap-2 text-cyan-200">
          <UserRound className="h-4 w-4" aria-hidden />
          <h2 className="text-xs font-black uppercase tracking-[0.2em]">Shared with me</h2>
        </div>
        {sharedWithMe.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-xs text-slate-500">No files have been shared with you.</p>
        ) : sharedWithMe.map((file) => {
          const connection = connections.find((candidate) => candidate.connectionId === file.connectionId);
          const draft = reviewDrafts[file.grantId]?.trim() || '';
          return (
            <article key={file.grantId} className="rounded-xl border border-cyan-500/20 bg-slate-950 p-3">
              <p className="break-words text-sm font-bold text-white">{file.originalFilename}</p>
              <p className="mt-1 text-[11px] text-slate-400">{file.projectTitle} · from {counterpartyLabel(connection)} · {file.byteSize.toLocaleString()} bytes</p>
              <p className="mt-2 text-[11px] text-cyan-200">{describeCollaboratorFilePermissions(file)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {file.canDownloadOriginal ? (
                  <a href={`/api/talent/audio/file-grants/${file.grantId}/download`} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-500 px-3 text-xs font-black text-slate-950">
                    <Download className="h-4 w-4" aria-hidden />
                    Download source file
                  </a>
                ) : null}
                <button type="button" onClick={() => { void loadReviews(file.grantId); }} disabled={busy} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white disabled:opacity-50">Review history</button>
              </div>
              {file.canComment ? (
                <textarea
                  value={reviewDrafts[file.grantId] || ''}
                  onChange={(event) => setReviewDrafts((current) => ({ ...current, [file.grantId]: event.target.value }))}
                  placeholder="Leave a review note"
                  aria-label={`Review note for ${file.originalFilename}`}
                  className="mt-3 min-h-20 w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-sm text-white"
                />
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {file.canComment ? (
                  <button type="button" onClick={() => { void sendReview(file.grantId, 'comment'); }} disabled={busy || !draft} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-cyan-500/30 px-3 text-xs font-bold text-cyan-100 disabled:opacity-50">
                    <MessageSquare className="h-4 w-4" aria-hidden />
                    Add note
                  </button>
                ) : null}
                {file.canComment ? (
                  <button type="button" onClick={() => { void sendReview(file.grantId, 'changes_requested'); }} disabled={busy || !draft} className="min-h-10 rounded-lg border border-amber-500/30 px-3 text-xs font-bold text-amber-100 disabled:opacity-50">Request changes</button>
                ) : null}
                {file.canApprove ? (
                  <button type="button" onClick={() => { void sendReview(file.grantId, 'approved'); }} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-emerald-500 px-3 text-xs font-black text-slate-950 disabled:opacity-50">
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    Approve
                  </button>
                ) : null}
              </div>
              {pendingGrantRevoke === file.grantId ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2">
                  <p className="mr-auto text-xs text-rose-100">Remove your access to this file?</p>
                  <button type="button" onClick={() => setPendingGrantRevoke(null)} className="min-h-9 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">Cancel</button>
                  <button type="button" onClick={() => { void revokeGrant(file.grantId); }} disabled={busy} className="min-h-9 rounded-lg bg-rose-500 px-3 text-xs font-black text-white disabled:opacity-50">Remove access</button>
                </div>
              ) : (
                <button type="button" onClick={() => setPendingGrantRevoke(file.grantId)} className="mt-3 min-h-9 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">Remove access</button>
              )}
              {renderReviewHistory(file.grantId)}
            </article>
          );
        })}
      </div>

      <div className="mt-6 space-y-3">
        <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Shared by me</h2>
        {sharedByMe.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-xs text-slate-500">You have no active file shares.</p>
        ) : sharedByMe.map((file) => {
          const connection = connections.find((candidate) => candidate.connectionId === file.connectionId);
          return (
            <article key={file.grantId} className="rounded-xl border border-white/10 bg-slate-950 p-3">
              <p className="break-words text-sm font-bold text-white">{file.originalFilename}</p>
              <p className="mt-1 text-[11px] text-slate-400">{file.projectTitle} · shared with {counterpartyLabel(connection)}</p>
              <p className="mt-2 text-[11px] text-violet-200">{describeCollaboratorFilePermissions(file)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => { void loadReviews(file.grantId); }} disabled={busy} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white disabled:opacity-50">Review history</button>
                {pendingGrantRevoke === file.grantId ? (
                  <>
                    <button type="button" onClick={() => setPendingGrantRevoke(null)} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">Cancel</button>
                    <button type="button" onClick={() => { void revokeGrant(file.grantId); }} disabled={busy} className="min-h-10 rounded-lg bg-rose-500 px-3 text-xs font-black text-white disabled:opacity-50">Revoke file access</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setPendingGrantRevoke(file.grantId)} className="min-h-10 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">Revoke file access</button>
                )}
              </div>
              {renderReviewHistory(file.grantId)}
            </article>
          );
        })}
      </div>
    </section>
  );

  if (embedded) return inbox;

  return (
    <div className="relative isolate min-h-[100dvh] overflow-hidden bg-slate-950 px-4 py-8 text-white sm:py-10">
      <AppBackdrop />
      <div className="relative mx-auto w-full max-w-3xl rounded-3xl border border-white/10 bg-slate-900/90 p-5 shadow-2xl backdrop-blur sm:p-6">
        <a href="/account" className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-bold text-slate-200">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to account
        </a>
        {inbox}
      </div>
    </div>
  );
}
