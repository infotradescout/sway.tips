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

type CandidateDecision = 'accepted' | 'rejected' | 'blocked';

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
  canDecideCandidate?: boolean;
  candidateDecision?: CandidateDecision | null;
  candidateDecisionReason?: string | null;
  candidateModerationStatus?: string | null;
  candidatePromotedVersionId?: string | null;
  canRevoke?: boolean;
  canReadReviews?: boolean;
  initiatedByCurrentUser?: boolean;
  managedByCurrentUser?: boolean;
};

export type CollaborationCapabilities = {
  candidateUploads: boolean;
  candidateRequestProjectIds: string[];
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
  onCandidateAccepted?: () => void;
};

const DISABLED_COLLABORATION_CAPABILITIES: CollaborationCapabilities = {
  candidateUploads: false,
  candidateRequestProjectIds: []
};

class CollaborationRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

class CollaborationContextEnded extends Error {}

type InboxOperation = { generation: number; accountId: string | null; controller: AbortController; kind: 'refresh' | 'action' };
const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function validConnection(value: unknown): value is FileConnection {
  return isRecord(value) && nonEmptyString(value.connectionId)
    && (value.counterparty === null || (isRecord(value.counterparty) && typeof value.counterparty.displayName === 'string'
      && (value.counterparty.handle === null || typeof value.counterparty.handle === 'string')));
}
function validFile(value: unknown): value is CollaboratorFile {
  return isRecord(value) && ['grantId', 'connectionId', 'projectTitle', 'versionId', 'originalFilename', 'sha256'].every(key => nonEmptyString(value[key]))
    && Number.isSafeInteger(value.byteSize) && value.byteSize >= 0
    && ['canDownloadOriginal', 'canComment', 'canApprove'].every(key => typeof value[key] === 'boolean')
    && (value.mimeType === undefined || typeof value.mimeType === 'string');
}
function validReview(value: unknown): value is ReviewEvent {
  return isRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.eventType)
    && (value.body === null || typeof value.body === 'string')
    && (value.timecodeMs === null || (Number.isSafeInteger(value.timecodeMs) && value.timecodeMs >= 0))
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt));
}

/** Deadline includes response JSON; the abort race also fences transports that ignore abort. */
async function requestCollaboration(url: string, init: RequestInit, signal: AbortSignal, fallback: string,
  onAccessDenied: (status: number) => void, allowPending = false) {
  signal.throwIfAborted();
  const transport = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const boundary = new Promise<never>((_, reject) => {
    cancel = () => { transport.abort(); reject(new CollaborationContextEnded()); };
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      transport.abort();
      reject(new Error(init.method && init.method !== 'GET'
        ? 'The result could not be confirmed in time. Refresh Collaborator Inbox before repeating the action.'
        : 'The request timed out. Refresh Collaborator Inbox to try again.'));
    }, 20_000);
  });
  try {
    return await Promise.race([boundary, (async () => {
      let response: Response;
      try { response = await fetch(url, { ...init, signal: transport.signal, redirect: 'error' }); }
      catch { throw new Error(init.method && init.method !== 'GET'
        ? 'The result could not be confirmed. Refresh Collaborator Inbox before repeating the action.' : fallback); }
      signal.throwIfAborted(); transport.signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        onAccessDenied(response.status);
        throw new CollaborationRequestError('Your account or file access changed. Refresh Collaborator Inbox to continue.', response.status);
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new Error('The server response could not be confirmed. Refresh Collaborator Inbox to check.'); }
      signal.throwIfAborted(); transport.signal.throwIfAborted();
      if (!isRecord(data)) throw new Error('The server returned an invalid response. Refresh Collaborator Inbox to check.');
      if (response.status === 409 && data.code === 'account_context_changed') {
        onAccessDenied(409);
        throw new CollaborationContextEnded();
      }
      if (response.status === 202 && !allowPending) throw new CollaborationRequestError('The upload is still being processed. Refresh Collaborator Inbox to check its status before trying the same file again.', 202);
      if (!response.ok) throw new CollaborationRequestError(typeof data.error === 'string' ? data.error : fallback, response.status);
      return data;
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    transport.abort();
  }
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
  onCollaborationStateChange,
  onCandidateAccepted
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
  const [listeningErrors, setListeningErrors] = useState<Record<string, boolean>>({});
  const [listeningRevision, setListeningRevision] = useState(0);
  const [capabilities, setCapabilities] = useState<CollaborationCapabilities>(DISABLED_COLLABORATION_CAPABILITIES);
  const refreshSequence = useRef(0);
  const mounted = useRef(false);
  const currentOperation = useRef<InboxOperation | null>(null);
  const currentAccountId = useRef<string | null>(null);
  const [inboxReady, setInboxReady] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<{ candidateId: string; decision: CandidateDecision } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const decisionKeys = useRef(new Map<string, string>());
  const decisionInFlight = useRef(false);
  const uploadController = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);

  const redirectToLogin = useCallback(() => {
    const params = new URLSearchParams({ next: '/account/collaboration' });
    window.location.replace(`/account/login?${params.toString()}`);
  }, []);
  const failClosed = useCallback(() => {
    setCapabilities(DISABLED_COLLABORATION_CAPABILITIES);
    onCollaborationStateChange?.(false);
  }, [onCollaborationStateChange]);
  const clearPrivateState = useCallback(() => {
    setInboxReady(false);
    setConnections([]); setSharedWithMe([]); setSharedByMe([]);
    setReviewsByGrant({}); setReviewDrafts({}); setListeningErrors({});
    setPendingGrantRevoke(null); setPendingConnectionRevoke(null); setPendingDecision(null); setDecisionReason('');
    decisionKeys.current.clear();
    onConnectionsLoaded?.([], DISABLED_COLLABORATION_CAPABILITIES);
    failClosed();
  }, [failClosed, onConnectionsLoaded]);
  const isCurrent = useCallback((operation: InboxOperation) => mounted.current
    && currentOperation.current === operation && operation.generation === refreshSequence.current, []);
  const assertCurrent = useCallback((operation: InboxOperation) => {
    operation.controller.signal.throwIfAborted();
    if (!isCurrent(operation)) throw new CollaborationContextEnded();
  }, [isCurrent]);
  const invalidateAccount = useCallback((message: string) => {
    refreshSequence.current += 1;
    currentOperation.current?.controller.abort(); currentOperation.current = null;
    currentAccountId.current = null; uploadController.current = null; decisionInFlight.current = false;
    clearPrivateState(); setBusy(false); setUploading(false); setStatus(message);
  }, [clearPrivateState]);
  const request = useCallback(async (operation: InboxOperation, url: string, init: RequestInit, fallback: string, allowPending = false) => {
    assertCurrent(operation);
    const data = await requestCollaboration(url, {
      ...init, headers: { ...init.headers, ...(url !== '/api/account/session' && operation.accountId
        ? { 'X-Sway-Expected-Account-Id': operation.accountId } : {}) }
    }, operation.controller.signal, fallback, statusCode => {
      if (!isCurrent(operation)) return;
      invalidateAccount('Your account or file access changed. Refresh Collaborator Inbox to continue.');
      if (statusCode === 401) redirectToLogin();
    }, allowPending);
    assertCurrent(operation);
    return data;
  }, [assertCurrent, invalidateAccount, isCurrent, redirectToLogin]);
  const checkAccount = useCallback(async (operation: InboxOperation, allowNewAccount = false) => {
    const session = await request(operation, '/api/account/session', { cache: 'no-store' }, 'Could not confirm the signed-in account.');
    assertCurrent(operation);
    if (!nonEmptyString(session.account?.id)) throw new Error('The signed-in account could not be confirmed. Refresh Collaborator Inbox.');
    const accountId = session.account.id;
    if (operation.accountId && operation.accountId !== accountId && !allowNewAccount) {
      invalidateAccount('The signed-in account changed. Private files were cleared. Refresh Collaborator Inbox to continue.');
      throw new CollaborationContextEnded();
    }
    if (currentAccountId.current !== accountId) clearPrivateState();
    operation.accountId = accountId;
    currentAccountId.current = accountId;
  }, [assertCurrent, clearPrivateState, invalidateAccount, request]);
  const scopedRequest = useCallback(async (operation: InboxOperation, url: string, init: RequestInit, fallback: string, allowPending = false) => {
    assertCurrent(operation);
    if (!operation.accountId) throw new CollaborationContextEnded();
    const data = await request(operation, url, init, fallback, allowPending);
    await checkAccount(operation);
    assertCurrent(operation);
    return data;
  }, [assertCurrent, checkAccount, request]);
  const beginOperation = useCallback((kind: InboxOperation['kind']) => {
    if (!mounted.current) return null;
    if (kind === 'action' && (currentOperation.current || !currentAccountId.current)) return null;
    currentOperation.current?.controller.abort();
    const operation: InboxOperation = { generation: ++refreshSequence.current, accountId: currentAccountId.current, controller: new AbortController(), kind };
    currentOperation.current = operation;
    setBusy(true); setStatus(null);
    return operation;
  }, []);
  const finishOperation = useCallback((operation: InboxOperation) => {
    if (!isCurrent(operation)) return;
    currentOperation.current = null;
    operation.controller.abort();
    uploadController.current = null; decisionInFlight.current = false;
    setBusy(false); setUploading(false);
  }, [isCurrent]);
  const loadSnapshot = useCallback(async (operation: InboxOperation, allowNewAccount = false) => {
    setInboxReady(false); failClosed();
    await checkAccount(operation, allowNewAccount);
    const [connectionsData, incomingData, outgoingData] = await Promise.all([
      request(operation, '/api/talent/audio/pairing/connections', { cache: 'no-store' }, 'Could not load file connections.'),
      request(operation, '/api/talent/audio/files/shared-with-me', { cache: 'no-store' }, 'Could not load files shared with you.'),
      request(operation, '/api/talent/audio/files/shared-by-me', { cache: 'no-store' }, 'Could not load files you shared.')
    ]);
    await checkAccount(operation);
    assertCurrent(operation);
    if (!Array.isArray(connectionsData.connections) || !connectionsData.connections.every(validConnection)
      || !Array.isArray(incomingData.files) || !incomingData.files.every(validFile)
      || !Array.isArray(outgoingData.files) || !outgoingData.files.every(validFile)) {
      throw new Error('The private file list could not be confirmed. Refresh Collaborator Inbox to try again.');
    }
    const nextCapabilities = { candidateUploads: connectionsData.capabilities?.candidateUploads === true
      && incomingData.capabilities?.candidateUploads === true && outgoingData.capabilities?.candidateUploads === true,
      candidateRequestProjectIds: Array.isArray(connectionsData.capabilities?.candidateRequestProjectIds)
        && connectionsData.capabilities.candidateRequestProjectIds.every(nonEmptyString)
        ? connectionsData.capabilities.candidateRequestProjectIds as string[] : [] };
    const nextConnections = connectionsData.connections as FileConnection[];
    setConnections(nextConnections); setSharedWithMe(incomingData.files); setSharedByMe(outgoingData.files);
    // Review rows are private to the refreshed grant snapshot; never retain an ended grant's thread.
    setReviewsByGrant(current => Object.fromEntries(Object.entries(current).filter(([grantId]) =>
      [...incomingData.files, ...outgoingData.files].some(file => file.grantId === grantId && file.canReadReviews === true))));
    setListeningErrors({}); setListeningRevision(current => current + 1);
    setCapabilities(nextCapabilities); setInboxReady(true);
    onConnectionsLoaded?.(nextConnections, nextCapabilities);
    onCollaborationStateChange?.(nextCapabilities.candidateUploads);
  }, [assertCurrent, checkAccount, failClosed, onCollaborationStateChange, onConnectionsLoaded, request]);
  const showOperationError = useCallback((operation: InboxOperation, error: unknown, fallback: string) => {
    if (!isCurrent(operation)) return;
    if (operation.controller.signal.aborted) {
      setStatus('Stopped waiting. Refresh Collaborator Inbox to check the result before repeating the action.');
      return;
    }
    if (!(error instanceof CollaborationRequestError) || error.status >= 500) { setInboxReady(false); failClosed(); }
    setStatus(error instanceof Error && error.message ? error.message : fallback);
  }, [failClosed, isCurrent]);
  const refresh = useCallback(async () => {
    const operation = beginOperation('refresh');
    if (!operation) return;
    try { await loadSnapshot(operation, true); }
    catch (error) { showOperationError(operation, error, 'Private file collaboration is temporarily unavailable.'); }
    finally { finishOperation(operation); }
  }, [beginOperation, finishOperation, loadSnapshot, showOperationError]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; refreshSequence.current += 1;
      currentOperation.current?.controller.abort(); currentOperation.current = null;
      currentAccountId.current = null;
    };
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    let probe: AbortController | null = null;
    const onFocus = () => {
      if (!currentAccountId.current) { void refresh(); return; }
      probe?.abort();
      const controller = new AbortController(); probe = controller;
      const generation = refreshSequence.current;
      const accountId = currentAccountId.current;
      const currentProbe = () => mounted.current && probe === controller && !controller.signal.aborted
        && generation === refreshSequence.current && currentAccountId.current === accountId;
      // Returning from a native file picker also focuses the window. Check identity
      // without replacing its input or canceling an upload when the account is unchanged.
      void (async () => {
        try {
          const session = await requestCollaboration('/api/account/session', { cache: 'no-store' }, controller.signal,
            'Could not confirm the current account.', () => {
              if (currentProbe()) invalidateAccount('Your account access changed. Refresh Collaborator Inbox.');
            });
          if (!currentProbe()) return;
          if (!nonEmptyString(session.account?.id)) throw new Error('The current account could not be confirmed.');
          if (session.account.id !== accountId) {
            invalidateAccount('The signed-in account changed. Refreshing private files…');
            void refresh();
          }
        } catch {
          if (currentProbe()) invalidateAccount('The current account could not be confirmed. Refresh Collaborator Inbox.');
        }
      })();
    };
    const onVisibility = () => {
      // Native file pickers and ordinary tab switches may hide this document.
      // Preserve the file input and active work; verify identity when it returns.
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisibility);
    return () => { probe?.abort(); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [invalidateAccount, refresh]);


  const runAction = async (action: (operation: InboxOperation) => Promise<void>, fallback: string) => {
    if (!inboxReady) return;
    const operation = beginOperation('action');
    if (!operation) return;
    try { await checkAccount(operation); await action(operation); }
    catch (error) { showOperationError(operation, error, fallback); }
    finally { finishOperation(operation); }
  };
  const readReviews = async (operation: InboxOperation, grantId: string) => {
    const data = await scopedRequest(operation, `/api/talent/audio/file-grants/${encodeURIComponent(grantId)}/reviews`, { cache: 'no-store' }, 'Could not load review activity.');
    assertCurrent(operation);
    if (!Array.isArray(data.events) || !data.events.every(validReview)) throw new Error('Review activity could not be confirmed. Refresh Collaborator Inbox to check.');
    setReviewsByGrant(current => ({ ...current, [grantId]: data.events }));
  };
  const loadReviews = (grantId: string) => runAction(operation => readReviews(operation, grantId), 'Could not load review activity.');
  const sendReview = (grantId: string, eventType: 'comment' | 'approved' | 'changes_requested') => runAction(async operation => {
    const data = await scopedRequest(operation, `/api/talent/audio/file-grants/${encodeURIComponent(grantId)}/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventType, body: reviewDrafts[grantId]?.trim() || undefined })
    }, 'Could not record review.');
    if (!validReview(data.event) || data.event.eventType !== eventType) throw new Error('The review result could not be confirmed. Refresh review history before repeating it.');
    await readReviews(operation, grantId);
    assertCurrent(operation);
    setReviewDrafts(current => ({ ...current, [grantId]: '' }));
    setStatus(eventType === 'approved' ? 'Approval recorded.' : 'Review note recorded.');
  }, 'Could not record review.');
  const revokeGrant = (grantId: string) => runAction(async operation => {
    const data = await scopedRequest(operation, `/api/talent/audio/file-grants/${encodeURIComponent(grantId)}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Removed from Collaborator Inbox.' })
    }, 'Could not revoke file access.', true);
    if (data.grantId !== grantId || typeof data.revokedAt !== 'string' || !Number.isFinite(Date.parse(data.revokedAt))) throw new Error('File revocation was not confirmed. Refresh Collaborator Inbox to check.');
    setPendingGrantRevoke(null);
    await loadSnapshot(operation);
    assertCurrent(operation);
    setStatus('File access revoked. Future download and review attempts are now denied.');
  }, 'Could not revoke file access.');
  const revokeConnection = (connectionId: string) => runAction(async operation => {
    const data = await scopedRequest(operation, `/api/talent/audio/pairing/connections/${encodeURIComponent(connectionId)}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Removed from Collaborator Inbox.' })
    }, 'Could not remove this connection.', true);
    if (data.connectionId !== connectionId || typeof data.revokedAt !== 'string' || !Number.isFinite(Date.parse(data.revokedAt))) throw new Error('Connection removal was not confirmed. Refresh Collaborator Inbox to check.');
    setPendingConnectionRevoke(null);
    await loadSnapshot(operation);
    assertCurrent(operation);
    setStatus('Connection removed. Its active file grants were revoked too.');
  }, 'Could not remove this connection.');

  const uploadPrivateCandidate = async (sharedFile: CollaboratorFile, file: File | null) => {
    if (!file || busy || uploadController.current || !inboxReady) return;
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

    const operation = beginOperation('action');
    if (!operation) return;
    const controller = operation.controller;
    uploadController.current = controller;
    setUploading(true);
    setBusy(true);
    setStatus('Checking this candidate request and available storage…');
    const requestUpload = (url: string, options: RequestInit, fallback: string) => scopedRequest(operation, url, options, fallback);
    try {
      await checkAccount(operation);
      const preflight = await requestUpload(
        `/api/talent/audio/file-grants/${encodeURIComponent(sharedFile.grantId)}/candidate-uploads/preflight`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, mimeType, byteSize: file.size }) },
        'Could not check candidate request and storage.'
      );
      if (preflight.ok !== true || !Number.isSafeInteger(preflight.maxCandidateBytes) || preflight.maxCandidateBytes < file.size) {
        throw new Error('The candidate request and storage were not confirmed. Refresh Collaborator Inbox before trying again.');
      }
      const expectedSha256 = await sha256FileHex(file, {
        signal: controller.signal,
        onProgress: (completedBytes, totalBytes) => { assertCurrent(operation); setStatus(`Preparing ${file.name}… ${Math.round(completedBytes / Math.max(1, totalBytes) * 100)}%`); }
      });
      const startData = await requestUpload(
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
        },
        'Could not start private-candidate upload.'
      );
      const uploadSessionId = startData.uploadSession?.id;
      if (typeof uploadSessionId !== 'string' || !uploadSessionId
        || startData.uploadSession.expectedByteSize !== file.size
        || startData.uploadSession.partSizeBytes !== AUDIO_UPLOAD_PART_SIZE_BYTES) {
        throw new Error('Private-candidate upload session was not returned.');
      }

      const parts = chunkFileForUpload(file);
      for (let index = 0; index < parts.length; index += 1) {
        setStatus(`Uploading private candidate part ${index + 1}/${parts.length}…`);
        const partData = await requestUpload(
          `/api/talent/audio/file-grants/${sharedFile.grantId}/candidate-uploads/${uploadSessionId}/parts/${index + 1}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: parts[index]
          },
          `Private-candidate part ${index + 1} failed.`
        );
        if (partData.part?.partNumber !== index + 1 || partData.part.byteSize !== parts[index].size) throw new Error(`Private-candidate part ${index + 1} was not confirmed. Refresh the inbox before retrying the same file.`);
      }

      setStatus('Validating and sealing private candidate…');
      const completeData = await requestUpload(
        `/api/talent/audio/file-grants/${sharedFile.grantId}/candidate-uploads/${uploadSessionId}/complete`,
        { method: 'POST' },
        'Could not seal private candidate.'
      );
      if (typeof completeData.candidate?.id !== 'string' || !completeData.candidate.id
        || completeData.candidate.sourceAssetVersionId !== sharedFile.versionId
        || completeData.candidate.byteSize !== file.size || completeData.candidate.sha256 !== expectedSha256
        || completeData.candidate.intakeStatus !== 'private_review') {
        throw new Error('Private candidate sealing was not confirmed. Refresh the inbox to check before retrying the same file.');
      }
      await loadSnapshot(operation);
      assertCurrent(operation);
      setStatus('Private candidate sealed for creator review. It did not replace the source or enter a release.');
    } catch (error) {
      if (isCurrent(operation) && controller.signal.aborted) setStatus('Stopped waiting for this upload. Refresh Collaborator Inbox to check its status before retrying the same file.');
      else showOperationError(operation, error, 'Private-candidate upload failed.');
    } finally { finishOperation(operation); }
  };

  const decideCandidate = async (file: CollaboratorFile) => {
    if (!pendingDecision || pendingDecision.candidateId !== file.candidateId
      || !file.canDecideCandidate || file.candidateDecision || !capabilities.candidateUploads || decisionInFlight.current || busy) return;
    const { candidateId, decision } = pendingDecision;
    if (decision === 'accepted' && ['held_for_review', 'blocked'].includes(file.candidateModerationStatus || '')) {
      setStatus('This candidate cannot be accepted while it is held or blocked.');
      return;
    }
    const reason = decisionReason.trim();
    if (decision !== 'accepted' && !reason) {
      setStatus('Add a reason before confirming this decision.');
      return;
    }
    const intent = JSON.stringify([candidateId, decision, reason]);
    let idempotencyKey = decisionKeys.current.get(intent);
    if (!idempotencyKey) {
      idempotencyKey = `candidate-decision:${candidateId}:${crypto.randomUUID()}`;
      decisionKeys.current.set(intent, idempotencyKey);
    }
    const operation = beginOperation('action');
    if (!operation) return;
    decisionInFlight.current = true;
    try {
      await checkAccount(operation);
      const data = await scopedRequest(operation,`/api/talent/audio/candidates/${encodeURIComponent(candidateId)}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, idempotencyKey, ...(reason ? { reason } : {}) })
      }, 'The candidate decision could not be confirmed.');
      assertCurrent(operation);
      const saved = data.decision;
      if (saved?.candidateId !== candidateId || saved?.decision !== decision
        || (decision === 'accepted' && (typeof saved.promotedVersionId !== 'string' || !saved.promotedVersionId))) {
        throw new Error('The candidate decision could not be confirmed. Refresh the inbox to check before trying again.');
      }
      const updateDecision = (files: CollaboratorFile[]) => files.map(current => current.candidateId === candidateId
        ? { ...current, canDecideCandidate: false, candidateDecision: decision, candidateDecisionReason: saved.reason ?? null, candidatePromotedVersionId: saved.promotedVersionId ?? null }
        : current);
      setSharedWithMe(updateDecision);
      setSharedByMe(updateDecision);
      setPendingDecision(null);
      setDecisionReason('');
      await loadSnapshot(operation);
      assertCurrent(operation);
      if (decision === 'accepted') onCandidateAccepted?.();
      setStatus(decision === 'accepted'
        ? 'Added as a new private file version. Your original is retained. Release and rights settings are unchanged.'
        : decision === 'blocked'
          ? 'Candidate blocked. This decision applies to this candidate; the account and connection remain unchanged.'
          : 'Candidate rejected. Your original is retained.');
    } catch (error) {
      showOperationError(operation, error, 'The candidate decision could not be confirmed. Refresh Collaborator Inbox to check its status, or retry the same decision.');
    } finally { finishOperation(operation); }
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
      const moderationRestricted = ['held_for_review', 'blocked'].includes(file.candidateModerationStatus || '');
      return (
        <div className="mt-3 rounded-xl border border-violet-500/25 bg-violet-500/10 p-3">
          <p className="text-xs font-black text-violet-100">
            {file.candidateDecision === 'accepted' ? 'Added as a new private file version' : file.candidateDecision === 'rejected' ? 'Candidate rejected' : file.candidateDecision === 'blocked' ? 'Candidate blocked' : audience === 'creator' ? 'Private candidate received for review' : 'Private candidate sealed for creator review'}
          </p>
          <p className="mt-1 break-words text-[11px] text-slate-300">
            {file.candidateOriginalFilename || 'Verified audio candidate'}
            {file.candidateByteSize ? ` · ${file.candidateByteSize.toLocaleString()} bytes` : ''}
          </p>
          {maxCandidateBytes ? (
            <p className="mt-1 text-[10px] text-violet-200">Original creator-approved request ceiling: {formatCandidateBytes(maxCandidateBytes)}</p>
          ) : null}
          {capabilities.candidateUploads && file.candidateDecision !== 'blocked' && !moderationRestricted ? (
            <>
              <audio
                key={`candidate:${file.candidateId}:${listeningRevision}`}
                controls
                preload="none"
                src={`/api/talent/audio/file-grants/${encodeURIComponent(file.grantId)}/candidates/${encodeURIComponent(file.candidateId)}/content`}
                className="mt-3 w-full"
                aria-label={`Play private candidate ${file.candidateOriginalFilename || ''}`.trim()}
                onError={() => setListeningErrors(current => ({ ...current, [`candidate:${file.candidateId}`]: true }))}
                onCanPlay={() => setListeningErrors(current => ({ ...current, [`candidate:${file.candidateId}`]: false }))}
              />
              {listeningErrors[`candidate:${file.candidateId}`] ? <p role="status" className="mt-2 text-xs text-amber-200">Candidate audio could not play. Refresh Collaborator Inbox to check access and try again.</p> : null}
            </>
          ) : moderationRestricted ? (
            <p className="mt-2 text-xs text-amber-200">{file.candidateModerationStatus === 'held_for_review' ? 'This candidate is on hold for review.' : 'This candidate is blocked.'} Playback and acceptance are unavailable. The owner can still reject or block a candidate awaiting a decision.</p>
          ) : file.candidateDecision !== 'blocked' ? (
            <p className="mt-2 text-[10px] text-slate-400">Playback is unavailable while private-candidate intake is disabled.</p>
          ) : <p className="mt-2 text-[10px] text-slate-400">Playback is unavailable for this blocked candidate.</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-violet-200">
            {file.candidateDecision === 'accepted'
              ? 'The owner added a new private working version. The original is retained. This does not select a release master or change rights.'
              : file.candidateDecision
                ? 'This candidate has not been added to Catalog or a release. The original stays unchanged.'
                : 'Kept separate from Catalog versions, requests, and releases until the owner accepts it as a new private working version. The original stays unchanged.'}
          </p>
          {file.candidateDecisionReason ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-300">Decision reason: {file.candidateDecisionReason}</p> : null}
          {audience === 'creator' && file.canDecideCandidate === true && !file.candidateDecision && capabilities.candidateUploads ? (
            pendingDecision?.candidateId === file.candidateId ? (
              <div className="mt-3 space-y-3 rounded-xl border border-white/20 bg-slate-950 p-3" role="group" aria-label="Confirm candidate decision">
                <p className="text-xs text-white">{pendingDecision.decision === 'accepted'
                  ? 'Add this exact candidate as a new private working version? Your original stays saved. It will not become a release master or be published automatically.'
                  : pendingDecision.decision === 'blocked'
                    ? 'Block this candidate? Candidate playback will stop. This does not block the account or remove your connection.'
                    : 'Reject this candidate? This records your decision and keeps your original unchanged.'}</p>
                <label className="block text-xs text-slate-300">
                  {pendingDecision.decision === 'accepted' ? 'Decision note (optional)' : 'Decision reason (required)'}
                  <textarea value={decisionReason} onChange={event => setDecisionReason(event.currentTarget.value)} maxLength={2000} disabled={busy}
                    className="mt-2 min-h-20 w-full rounded-lg border border-white/10 bg-slate-900 p-2 text-sm text-white" />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={() => { setPendingDecision(null); setDecisionReason(''); }} className="min-h-11 rounded-lg border border-white/20 px-3 text-xs font-bold text-white disabled:opacity-50">Cancel decision</button>
                  <button type="button" disabled={busy || (pendingDecision.decision !== 'accepted' && !decisionReason.trim()) || (pendingDecision.decision === 'accepted' && moderationRestricted)} onClick={() => { void decideCandidate(file); }} className="min-h-11 rounded-lg bg-violet-500 px-3 text-xs font-black text-white disabled:opacity-50">{pendingDecision.decision === 'accepted' ? 'Confirm add private version' : pendingDecision.decision === 'blocked' ? 'Confirm block candidate' : 'Confirm reject candidate'}</button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2" aria-label="Owner candidate decisions">
                {(['accepted', 'rejected', 'blocked'] as const).map(decision => <button key={decision} type="button" disabled={busy || (decision === 'accepted' && moderationRestricted)} onClick={() => { setPendingDecision({ candidateId: file.candidateId!, decision }); setDecisionReason(''); }} className="min-h-11 rounded-lg border border-violet-300/30 px-3 text-xs font-bold text-violet-100 disabled:opacity-50">{decision === 'accepted' ? 'Add as private version' : decision === 'rejected' ? 'Reject candidate' : 'Block candidate'}</button>)}
              </div>
            )
          ) : null}
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
          disabled={uploading || decisionInFlight.current}
          aria-label="Refresh Collaborator Inbox"
          className="rounded-xl border border-white/10 bg-slate-950 p-3 text-slate-300 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
        </button>
      </div>

      {uploading ? <button type="button" onClick={() => uploadController.current?.abort()} className="mt-3 min-h-11 rounded-xl border border-amber-500/30 px-3 text-xs font-bold text-amber-100">Stop waiting for upload</button> : null}
      {status ? (
        <p role="status" aria-live="polite" className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-cyan-100">
          {status}
        </p>
      ) : null}

      {!inboxReady ? <p className="mt-5 text-xs text-slate-400">Private files are unavailable until the current account and file list are confirmed.</p> : <>
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
              {file.canDownloadOriginal && file.mimeType?.startsWith('audio/') ? (
                <div className="mt-3 space-y-2">
                  <audio
                    key={`${file.grantId}:${listeningRevision}`}
                    controls
                    preload="none"
                    src={`/api/talent/audio/file-grants/${encodeURIComponent(file.grantId)}/listen`}
                    aria-label={`Listen to ${file.originalFilename}`}
                    className="w-full"
                    onError={() => setListeningErrors((current) => ({ ...current, [file.grantId]: true }))}
                    onCanPlay={() => setListeningErrors((current) => ({ ...current, [file.grantId]: false }))}
                  />
                  {listeningErrors[file.grantId] ? (
                    <p role="status" className="text-xs text-amber-200">Audio could not play. Refresh to check access, or download the source file to listen in a compatible player.</p>
                  ) : null}
                </div>
              ) : null}
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
      </>}
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
