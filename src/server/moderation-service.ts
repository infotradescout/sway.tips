import { createHash } from 'crypto';
import { createSwayDb } from '../db/client';
import { moderationEvents } from '../db/schema';

export type ModerationOutageBehavior =
  | 'allow_with_local_filter'
  | 'hold_for_review'
  | 'block_submission';

export type BlockScope = 'patron_user_id' | 'patron_device_id_hash' | 'sender_name';

type LocalSignal = 'allow' | 'review' | 'block';

type AiAssistiveSignal = 'allow' | 'review' | 'block' | 'unavailable';

type BlockRule = {
  scope: BlockScope;
  value: string;
  reason: string;
};

const localReviewTerms = ['spam', 'abuse', 'vulgarword', 'asshole', 'bitch', 'bastard'];
const localBlockTerms = ['kill you', 'hurt you', 'attack everyone', 'hate crime'];
const localReviewPatterns = [/\b(?:https?:\/\/|www\.)\S+/i, /\b(?:nude|sexual)\b/i];
const localBlockPatterns = [/\b(?:kill|hurt|attack)\s+(?:you|him|her|them|everyone)\b/i];

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function toModerationEntityUuid(input: string): string {
  const digest = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function pickStricterSignal(a: LocalSignal, b: AiAssistiveSignal): LocalSignal {
  const severityRank: Record<LocalSignal | AiAssistiveSignal, number> = {
    allow: 0,
    unavailable: 0,
    review: 1,
    block: 2
  };

  if (severityRank[b] > severityRank[a]) {
    return b as LocalSignal;
  }

  return a;
}

export function createModerationService(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;
  const blockRules = new Map<string, BlockRule>();

  function evaluateLocalSignal(input: { senderName: string; text: string }): { signal: LocalSignal; reason?: string } {
    const haystack = `${input.senderName} ${input.text}`.toLowerCase();

    for (const term of localBlockTerms) {
      if (haystack.includes(term)) {
        return { signal: 'block', reason: 'Deterministic local moderation blocked this submission.' };
      }
    }

    for (const pattern of localBlockPatterns) {
      if (pattern.test(haystack)) {
        return { signal: 'block', reason: 'Deterministic local moderation blocked this submission.' };
      }
    }

    for (const term of localReviewTerms) {
      if (haystack.includes(term)) {
        return { signal: 'review', reason: 'Submission held for review by deterministic local moderation.' };
      }
    }

    for (const pattern of localReviewPatterns) {
      if (pattern.test(haystack)) {
        return { signal: 'review', reason: 'Submission held for review by deterministic local moderation.' };
      }
    }

    return { signal: 'allow' };
  }

  function findMatchingBlock(input: {
    patronUserId?: string | null;
    patronDeviceIdHash?: string | null;
    senderName?: string | null;
  }): BlockRule | null {
    const candidates: Array<[BlockScope, string | null | undefined]> = [
      ['patron_user_id', input.patronUserId],
      ['patron_device_id_hash', input.patronDeviceIdHash],
      ['sender_name', input.senderName]
    ];

    for (const [scope, rawValue] of candidates) {
      if (!rawValue) continue;
      const key = `${scope}:${normalizeKey(rawValue)}`;
      const existing = blockRules.get(key);
      if (existing) return existing;
    }

    return null;
  }

  async function writeModerationEvent(input: {
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    status: 'allowed' | 'held_for_review' | 'blocked';
    reason?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!db) {
      return { status: 'unavailable' as const };
    }

    await db.insert(moderationEvents).values({
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: toModerationEntityUuid(input.entityId),
      status: input.status,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {}
    });

    return { status: 'written' as const };
  }

  async function evaluateSubmission(input: {
    senderName: string;
    text: string;
    patronUserId?: string | null;
    patronDeviceIdHash?: string | null;
    aiAssistiveModeration?: () => Promise<AiAssistiveSignal>;
  }) {
    const blockMatch = findMatchingBlock({
      patronUserId: input.patronUserId,
      patronDeviceIdHash: input.patronDeviceIdHash,
      senderName: input.senderName
    });

    if (blockMatch) {
      return {
        decision: 'block_submission' as ModerationOutageBehavior,
        reason: `Blocked by ${blockMatch.scope} rule: ${blockMatch.reason}`,
        aiAssistiveUsed: false,
        aiAvailable: false
      };
    }

    const localSignal = evaluateLocalSignal({ senderName: input.senderName, text: input.text });
    let aiAssistiveUsed = false;
    let aiAvailable = false;
    let mergedSignal = localSignal.signal;

    if (input.aiAssistiveModeration) {
      aiAssistiveUsed = true;
      try {
        const aiSignal = await input.aiAssistiveModeration();
        aiAvailable = aiSignal !== 'unavailable';
        // AI moderation remains assistive only: it can tighten but never bypass local checks.
        mergedSignal = pickStricterSignal(localSignal.signal, aiSignal);
      } catch {
        aiAvailable = false;
      }
    }

    if (mergedSignal === 'block') {
      return {
        decision: 'block_submission' as ModerationOutageBehavior,
        reason: localSignal.reason ?? 'Submission blocked by moderation policy.',
        aiAssistiveUsed,
        aiAvailable
      };
    }

    if (mergedSignal === 'review') {
      return {
        decision: 'hold_for_review' as ModerationOutageBehavior,
        reason: localSignal.reason ?? 'Submission held for review by moderation policy.',
        aiAssistiveUsed,
        aiAvailable
      };
    }

    return {
      decision: 'allow_with_local_filter' as ModerationOutageBehavior,
      reason: 'Submission allowed after deterministic local filter.',
      aiAssistiveUsed,
      aiAvailable
    };
  }

  async function addBlockRule(input: {
    scope: BlockScope;
    value: string;
    reason: string;
    actorUserId?: string | null;
  }) {
    const key = `${input.scope}:${normalizeKey(input.value)}`;
    const rule: BlockRule = {
      scope: input.scope,
      value: normalizeKey(input.value),
      reason: input.reason
    };
    blockRules.set(key, rule);

    await writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'block_rule',
      entityId: key,
      status: 'blocked',
      reason: input.reason,
      metadata: {
        scope: input.scope,
        value: rule.value,
        source: 'moderation.block'
      }
    });

    return { status: 'blocked' as const };
  }

  async function recordPatronReport(input: {
    requestId: string;
    reason: string;
    details?: string;
    actorUserId?: string | null;
    patronDeviceIdHash?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'request_report',
      entityId: input.requestId,
      status: 'held_for_review',
      reason: input.reason,
      metadata: {
        details: input.details ?? null,
        patronDeviceIdHash: input.patronDeviceIdHash ?? null,
        source: 'moderation.report'
      }
    });
  }

  async function hideRequest(input: {
    requestId: string;
    reason: string;
    actorUserId?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'request_visibility',
      entityId: input.requestId,
      status: 'held_for_review',
      reason: input.reason,
      metadata: { action: 'hide', source: 'moderation.hide' }
    });
  }

  async function removeRequest(input: {
    requestId: string;
    reason: string;
    actorUserId?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'request_visibility',
      entityId: input.requestId,
      status: 'blocked',
      reason: input.reason,
      metadata: { action: 'remove', source: 'moderation.remove' }
    });
  }

  function getAppStoreUgcControlPlaceholders() {
    return {
      report: '/api/moderation/report',
      block: '/api/moderation/block',
      removeHide: ['/api/moderation/hide', '/api/moderation/remove'],
      supportContact: '/api/support/contact',
      dataDeletionPlaceholder: '/api/privacy/data-deletion-placeholder'
    };
  }

  return {
    hasDurableStore: Boolean(db),
    evaluateSubmission,
    addBlockRule,
    recordPatronReport,
    hideRequest,
    removeRequest,
    getAppStoreUgcControlPlaceholders
  };
}