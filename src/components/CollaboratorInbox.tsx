import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Link2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Upload,
  UserRound,
  X
} from 'lucide-react';
import {
  AUDIO_UPLOAD_PART_SIZE_BYTES,
  chunkFileForUpload,
  resolveAudioUploadMimeType,
  sha256FileHex
} from '../audio-upload-client';
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
  grantPurpose?: 'review_share' | 'collaborator_revision_upload';
  canUploadCandidateRevision?: boolean;
  maxCandidateBytes?: number | null;
  canDownloadOriginal: boolean;
  canComment: boolean;
  canApprove: boolean;
  expiresAt?: string | null;
  revokedAt?: string | null;
  candidateId?: string | null;
  candidateOriginalFilename?: string | null;
  candidateMimeType?: string | null;
  candidateByteSize?: number | null;
  candidateSha256?: string | null;
  candidateDurationMs?: number | null;
  candidateSealedAt?: string | null;
  canRevoke?: boolean;
  canReadReviews?: boolean;
  initiatedByCurrentUser?: boolean;
  managedByCurrentUser?: boolean;
};

export type CollaborationCapabilities = {
  candidateUploads: boolean;
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
  onConnectionsLoaded?: (
    connections: FileConnection[],
    capabilities: CollaborationCapabilities
  ) => void;
  onCollaborationStateChange?: (candidateUploads: boolean) => void;
};

const DISABLED_COLLABORATION_CAPABILITIES: CollaborationCapabilities = {
  candidateUploads: false
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

export function describeCollaboratorFilePermissions(file: Pick<
  CollaboratorFile,
  'canUploadCandidateRevision' | 'canDownloadOriginal' | 'canComment' | 'canApprove'
>) {
  const permissions = [];
  if (file.canUploadCandidateRevision) permissions.push('One private candidate upload');
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

function isFileGrantActive(file: CollaboratorFile) {
  if (file.revokedAt) return false;
  if (!file.expiresAt) return true;
  const expiresAt = Date.parse(file.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function candidateByteLimit(file: Pick<CollaboratorFile, 'maxCandidateBytes'>) {
  return typeof file.maxCandidateBytes === 'number'
    && Number.isSafeInteger(file.maxCandidateBytes)
    && file.maxCandidateBytes > 0
    ? file.maxCandidateBytes
    : null;
}

function formatCandidateBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 })} ${units[unitIndex]}`;
}

export default function CollaboratorInbox({
  embedded = false,
  refreshKey = 0,
  onConnectionsLoaded,
  onCollaborationStateChange
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
  const [capabilities, setCapabilities] = useState<CollaborationCapabilities>(DISABLED_COLLABORATION_CAPABILITIES);
  const refreshSequence = useRef(0);

  const redirectToLogin = useCallback(() => {
    const params = new URLSearchParams({ next: '/account/collaboration' });
    window.location.replace(`/account/login?${params.toString()}`);
  }, []);

  const failClosed = useCallback(() => {
    setCapabilities(DISABLED_COLLABORATION_CAPABILITIES);
    onCollaborationStateChange?.(false);
  }, [onCollaborationStateChange]);

  const refresh = useCallback(async () => {
    const refreshId = ++refreshSequence.current;
    failClosed();
    setBusy(true);
    setStatus(null);
    try {
      const responses = await Promise.all([
        fetch('/api/talent/audio/pairing/connections', { cache: 'no-store' }),
        fetch('/api/talent/audio/files/shared-with-me', { cache: 'no-store' }),
        fetch('/api/talent/audio/files/shared-by-me', { cache: 'no-store' })
      ]);
      if (responses.some((response) => response.status === 401)) {
        if (refreshId !== refreshSequence.current) return;
        failClosed();
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
      const nextCapabilities: CollaborationCapabilities = {
        candidateUploads: connectionsData.capabilities?.candidateUploads === true
          && incomingData.capabilities?.candidateUploads === true
          && outgoingData.capabilities?.candidateUploads === true
      };
      if (refreshId !== refreshSequence.current) return;
      setConnections(nextConnections);
      setSharedWithMe(Array.isArray(incomingData.files) ? incomingData.files : []);
      setSharedByMe(Array.isArray(outgoingData.files) ? outgoingData.files : []);
      setCapabilities(nextCapabilities);
      onConnectionsLoaded?.(nextConnections, nextCapabilities);
      onCollaborationStateChange?.(nextCapabilities.candidateUploads);
    } catch (error) {
      if (refreshId !== refreshSequence.current) return;
      failClosed();
      if (error instanceof CollaborationRequestError && error.status === 401) {
        redirectToLogin();
        return;
      }
      setStatus(error instanceof Error ? error.message : 'Private file collaboration is temporarily unavailable.');
    } finally {
      if (refreshId === refreshSequence.current) setBusy(false);
    }
  }, [failClosed, onCollaborationStateChange, onConnectionsLoaded, redirectToLogin]);

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

  const uploadPrivateCandidate = async (sharedFile: CollaboratorFile, file: File | null) => {
    if (!file) return;
    if (!capabilities.candidateUploads
      || !sharedFile.canUploadCandidateRevision
      || sharedFile.grantPurpose !== 'collaborator_revision_upload'
      || sharedFile.candidateId) {
      setStatus('This private-candidate upload is not currently authorized.');
      return;
    }
    if (file.size <= 0) {
      setStatus('Choose a non-empty audio file.');
      return;
    }
    const maxCandidateBytes = candidateByteLimit(sharedFile);
    if (!maxCandidateBytes) {
      setStatus('This private-candidate request has no valid creator-approved upload ceiling. Ask the creator to renew it.');
      return;
    }
    if (file.size > maxCandidateBytes) {
      setStatus(`This file exceeds this request's creator-approved ${formatCandidateBytes(maxCandidateBytes)} candidate ceiling.`);
      return;
    }
    const mimeType = resolveAudioUploadMimeType(file);
    if (!mimeType) {
      setStatus('Choose a supported audio file: WAV, AIFF, FLAC, MP3, M4A, AAC, or OGG.');
      return;
    }

    setBusy(true);
    setStatus(`Hashing ${file.name}…`);
    try {
      const expectedSha256 = await sha256FileHex(file);
      const startResponse = await fetch(
        `/api/talent/audio/file-grants/${sharedFile.grantId}/candidate-uploads`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalFilename: file.name,
            mimeType,
            expectedByteSize: file.size,
            expectedSha256,
            idempotencyKey: `candidate-upload:${sharedFile.grantId}:${expectedSha256}:${file.size}`,
            partSizeBytes: AUDIO_UPLOAD_PART_SIZE_BYTES
          })
        }
      );
      const startData = await readCollaborationResponse(startResponse, 'Could not start private-candidate upload.');
      const uploadSessionId = startData.uploadSession?.id;
      if (typeof uploadSessionId !== 'string' || !uploadSessionId) {
        throw new Error('Private-candidate upload session was not returned.');
      }

      const parts = chunkFileForUpload(file);
      for (let index = 0; index < parts.length; index += 1) {
        setStatus(`Uploading private candidate part ${index + 1}/${parts.length}…`);
        const partResponse = await fetch(
          `/api/talent/audio/file-grants/${sharedFile.grantId}/candidate-uploads/${uploadSessionId}/parts/${index + 1}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: parts[index]
          }
        );
        await readCollaborationResponse(partResponse, `Private-candidate part ${index + 1} failed.`);
      }

      setStatus('Validating and sealing private candidate…');
      const completeResponse = await fetch(
        `/api/talent/audio/file-grants/${sharedFile.grantId}/candidate-uploads/${uploadSessionId}/complete`,
        { method: 'POST' }
      );
      await readCollaborationResponse(completeResponse, 'Could not seal private candidate.');
      await refresh();
      setStatus('Private candidate sealed for creator review. It did not replace the source or enter a release.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Private-candidate upload failed.');
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

  const renderCandidate = (file: CollaboratorFile, audience: 'collaborator' | 'creator') => {
    const maxCandidateBytes = candidateByteLimit(file);
    if (file.candidateId) {
      return (
        <div className="mt-3 rounded-xl border border-violet-500/25 bg-violet-500/10 p-3">
          <p className="text-xs font-black text-violet-100">
            {audience === 'creator' ? 'Private candidate received for review' : 'Private candidate sealed for creator review'}
          </p>
          <p className="mt-1 break-words text-[11px] text-slate-300">
            {file.candidateOriginalFilename || 'Verified audio candidate'}
            {file.candidateByteSize ? ` · ${file.candidateByteSize.toLocaleString()} bytes` : ''}
          </p>
          {maxCandidateBytes ? (
            <p className="mt-1 text-[10px] text-violet-200">Original creator-approved request ceiling: {formatCandidateBytes(maxCandidateBytes)}</p>
          ) : null}
          {capabilities.candidateUploads ? (
            <audio
              controls
              preload="metadata"
              src={`/api/talent/audio/file-grants/${file.grantId}/candidates/${file.candidateId}/content`}
              className="mt-3 w-full"
              aria-label={`Play private candidate ${file.candidateOriginalFilename || ''}`.trim()}
            />
          ) : (
            <p className="mt-2 text-[10px] text-slate-400">Playback is unavailable while private-candidate intake is disabled.</p>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-violet-200">
            Kept separate from Catalog versions, requests, releases, and delivery. It remains in the creator's bounded working-storage pool.
          </p>
        </div>
      );
    }

    if (audience === 'collaborator'
      && file.grantPurpose === 'collaborator_revision_upload'
      && file.canUploadCandidateRevision) {
      return (
        <div className="mt-3 rounded-xl border border-violet-500/25 bg-violet-500/10 p-3">
          <p className="text-[11px] leading-relaxed text-violet-100">
            Upload one private audio candidate for creator review
            {maxCandidateBytes ? `, up to this request's creator-approved ${formatCandidateBytes(maxCandidateBytes)} ceiling` : ''}.
            {' '}It does not replace the current file, become requestable, or enter a release.
          </p>
          {capabilities.candidateUploads && maxCandidateBytes ? (
            <label className="relative mt-3 inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-violet-500 px-3 text-xs font-black text-white focus-within:ring-2 focus-within:ring-violet-200">
              <Upload className="h-4 w-4" aria-hidden />
              Upload private candidate
              <input
                type="file"
                accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.aac,.ogg"
                aria-label={`Upload private candidate for ${file.originalFilename}`}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                disabled={busy}
                onChange={(event) => {
                  const selectedFile = event.currentTarget.files?.[0] ?? null;
                  event.currentTarget.value = '';
                  void uploadPrivateCandidate(file, selectedFile);
                }}
              />
            </label>
          ) : capabilities.candidateUploads ? (
            <p className="mt-2 text-[10px] text-slate-400">The creator-approved request ceiling is unavailable. Ask the creator to renew this request.</p>
          ) : (
            <p className="mt-2 text-[10px] text-slate-400">Private-candidate intake is currently disabled.</p>
          )}
        </div>
      );
    }
    return null;
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
              {renderCandidate(file, 'collaborator')}
              <div className="mt-3 flex flex-wrap gap-2">
                {file.canDownloadOriginal ? (
                  <a href={`/api/talent/audio/file-grants/${file.grantId}/download`} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-500 px-3 text-xs font-black text-slate-950">
                    <Download className="h-4 w-4" aria-hidden />
                    Download source file
                  </a>
                ) : null}
                {file.canReadReviews === true ? (
                  <button type="button" onClick={() => { void loadReviews(file.grantId); }} disabled={busy} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white disabled:opacity-50">Review history</button>
                ) : null}
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
              {file.canRevoke === true && pendingGrantRevoke === file.grantId ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2">
                  <p className="mr-auto text-xs text-rose-100">Remove your access to this file?</p>
                  <button type="button" onClick={() => setPendingGrantRevoke(null)} className="min-h-9 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">Cancel</button>
                  <button type="button" onClick={() => { void revokeGrant(file.grantId); }} disabled={busy} className="min-h-9 rounded-lg bg-rose-500 px-3 text-xs font-black text-white disabled:opacity-50">Remove access</button>
                </div>
              ) : file.canRevoke === true ? (
                <button type="button" onClick={() => setPendingGrantRevoke(file.grantId)} className="mt-3 min-h-9 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">Remove access</button>
              ) : null}
              {file.canReadReviews === true ? renderReviewHistory(file.grantId) : null}
            </article>
          );
        })}
      </div>

      <div className="mt-6 space-y-3">
        <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Shares I created or manage</h2>
        {sharedByMe.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-xs text-slate-500">You have no active shares or sealed private candidates to manage.</p>
        ) : sharedByMe.map((file) => {
          const connection = connections.find((candidate) => candidate.connectionId === file.connectionId);
          const grantActive = isFileGrantActive(file);
          return (
            <article key={file.grantId} className="rounded-xl border border-white/10 bg-slate-950 p-3">
              <p className="break-words text-sm font-bold text-white">{file.originalFilename}</p>
              <p className="mt-1 text-[11px] text-slate-400">
                {file.projectTitle} · {file.grantPurpose === 'collaborator_revision_upload'
                  ? `${file.initiatedByCurrentUser ? 'candidate requested from' : 'project candidate from'} ${counterpartyLabel(connection)}`
                  : `shared with ${counterpartyLabel(connection)}`}
              </p>
              <p className="mt-2 text-[11px] text-violet-200">
                {grantActive
                  ? describeCollaboratorFilePermissions(file)
                  : `Original permission: ${describeCollaboratorFilePermissions(file)}`}
              </p>
              {renderCandidate(file, 'creator')}
              <div className="mt-3 flex flex-wrap gap-2">
                {file.canReadReviews === true ? (
                  <button type="button" onClick={() => { void loadReviews(file.grantId); }} disabled={busy} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white disabled:opacity-50">Review history</button>
                ) : null}
                {!grantActive && file.candidateId ? (
                  <p className="self-center text-[10px] text-slate-400">Upload authority ended; the sealed candidate remains creator-visible.</p>
                ) : file.canRevoke === true && pendingGrantRevoke === file.grantId ? (
                  <>
                    <button type="button" onClick={() => setPendingGrantRevoke(null)} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">Cancel</button>
                    <button type="button" onClick={() => { void revokeGrant(file.grantId); }} disabled={busy} className="min-h-10 rounded-lg bg-rose-500 px-3 text-xs font-black text-white disabled:opacity-50">Revoke file access</button>
                  </>
                ) : grantActive && file.canRevoke === true ? (
                  <button type="button" onClick={() => setPendingGrantRevoke(file.grantId)} className="min-h-10 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">Revoke file access</button>
                ) : grantActive && file.managedByCurrentUser ? (
                  <p className="self-center text-[10px] text-slate-400">Current project-manager access allows inspection; only a grant participant can end this upload permission.</p>
                ) : null}
              </div>
              {file.canReadReviews === true ? renderReviewHistory(file.grantId) : null}
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
