import { createHash, randomUUID } from 'node:crypto';

// Keep ambiguity longer than the cloud command's 60-second execution window,
// but still bound offline retries to two minutes.
export const LOCAL_PLAYBACK_SUBMISSION_TTL_MS = 120_000;

export function bridgeAuthGeneration(authToken) {
  return createHash('sha256').update(String(authToken), 'utf8').digest('hex');
}

export function createBridgeLedger({ gigId, authGeneration, deck = 1, createId = randomUUID }) {
  return {
    version: 2,
    gigId,
    sourceKey: 'virtualdj',
    authGeneration,
    bridgeInstanceId: createId(),
    targetDeck: deck,
    outcomes: {},
    pendingCompletionIds: [],
    submissions: {}
  };
}

export function restoreBridgeLedger(parsed, options) {
  if (!parsed || parsed.version !== 2 || parsed.gigId !== options.gigId
    || parsed.sourceKey !== 'virtualdj' || parsed.authGeneration !== options.authGeneration
    || typeof parsed.bridgeInstanceId !== 'string' || !parsed.bridgeInstanceId) {
    return createBridgeLedger(options);
  }
  return {
    version: 2,
    gigId: options.gigId,
    sourceKey: 'virtualdj',
    authGeneration: options.authGeneration,
    bridgeInstanceId: parsed.bridgeInstanceId,
    targetDeck: Number.isInteger(parsed.targetDeck) && parsed.targetDeck >= 1 && parsed.targetDeck <= 8 ? parsed.targetDeck : options.deck,
    outcomes: parsed.outcomes && typeof parsed.outcomes === 'object' && !Array.isArray(parsed.outcomes) ? parsed.outcomes : {},
    pendingCompletionIds: Array.isArray(parsed.pendingCompletionIds) ? parsed.pendingCompletionIds : [],
    submissions: parsed.submissions && typeof parsed.submissions === 'object' && !Array.isArray(parsed.submissions) ? parsed.submissions : {}
  };
}

export function playbackSubmissionIntentKey(intent) {
  return createHash('sha256').update(JSON.stringify(intent), 'utf8').digest('hex');
}

export function reservePlaybackSubmission(ledger, intent, {
  now = Date.now(),
  createId = randomUUID,
  ttlMs = LOCAL_PLAYBACK_SUBMISSION_TTL_MS
} = {}) {
  for (const [key, value] of Object.entries(ledger.submissions ?? {})) {
    if (!value || !Number.isFinite(value.createdAt) || now - value.createdAt > ttlMs || value.createdAt > now + 5_000) {
      delete ledger.submissions[key];
    }
  }
  const intentKey = playbackSubmissionIntentKey(intent);
  const existing = ledger.submissions[intentKey];
  if (existing && typeof existing.clientCommandId === 'string') return { intentKey, ...existing, replay: true };
  if (Object.keys(ledger.submissions).length > 0) {
    throw new Error('A previous playback submission is unresolved. Retry that same action or wait for its local safety window to expire.');
  }
  const created = { clientCommandId: createId(), createdAt: now };
  ledger.submissions[intentKey] = created;
  return { intentKey, ...created, replay: false };
}

export function resolvePlaybackSubmission(ledger, intentKey, clientCommandId) {
  if (clientCommandId !== undefined
    && ledger.submissions?.[intentKey]?.clientCommandId !== clientCommandId) return false;
  if (ledger.submissions) delete ledger.submissions[intentKey];
  return true;
}

export async function submitReservedPlaybackCommand({
  ledger,
  intent,
  persist,
  submit,
  reserveOptions
}) {
  const submission = reservePlaybackSubmission(ledger, intent, reserveOptions);
  // The first durable write must finish before the request can reach Sway.
  // Every thrown/non-2xx response remains ambiguous and deliberately keeps
  // this identity until a successful replay receipt or the local safety TTL.
  await persist();
  const receipt = await submit(submission.clientCommandId);
  const command = receipt?.command;
  if (receipt?.success !== true || typeof command?.id !== 'string' || !command.id.trim()
    || command.clientCommandId !== submission.clientCommandId
    || command.gigId !== ledger.gigId || command.sourceKey !== intent.sourceKey
    || command.action !== intent.action
    || !['queued', 'claimed', 'succeeded', 'failed', 'expired'].includes(command.status)) {
    throw new Error('Sway receipt could not confirm this command identity. Retry the same action to recover its receipt.');
  }
  const retained = {
    clientCommandId: submission.clientCommandId,
    createdAt: submission.createdAt
  };
  // A delayed replay receipt belongs to its original submission. It cannot
  // clear a later deliberate command which now uses the same intent key.
  if (!resolvePlaybackSubmission(ledger, submission.intentKey, submission.clientCommandId)) return receipt;
  try {
    await persist();
  } catch (error) {
    // saveLedger is atomic and its prior durable file still has the reservation.
    // Restore memory too so a same-process retry cannot manufacture a new id.
    if (!ledger.submissions[submission.intentKey]) ledger.submissions[submission.intentKey] = retained;
    throw error;
  }
  return receipt;
}

export function acceptedTargetDeck(currentDeck, result) {
  const candidate = Number(result?.deck);
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= 8 ? candidate : currentDeck;
}

export function isPlaybackCompletionReceipt(receipt, { commandId, gigId, sourceKey, success }) {
  const command = receipt?.command;
  return typeof success === 'boolean' && receipt?.success === true
    && command?.id === commandId && command.gigId === gigId && command.sourceKey === sourceKey
    && command.status === (success ? 'succeeded' : 'failed');
}
