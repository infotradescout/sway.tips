import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface DistributionRecordingPayload {
  recordingId: string;
  isrc: string | null;
  title: string;
  primaryArtistName: string;
  trackNumber: number;
  discNumber: number;
}

export interface DistributionReleasePayload {
  releaseId: string;
  providerKey: string;
  destinationKey: string;
  title: string;
  primaryArtistName: string;
  releaseType: string;
  upc: string | null;
  originalReleaseDate: string;
  territories: string[];
  recordings: DistributionRecordingPayload[];
}

export interface DistributionSubmissionResult {
  providerReleaseId: string;
}

export interface DistributionWebhookEvent {
  providerEventId: string;
  providerReleaseId: string;
  destinationKey: string;
  status: 'accepted' | 'live' | 'correction_pending' | 'failed' | 'taken_down';
  destinationReleaseId: string | null;
  error: string | null;
}

export interface DistributionAdapter {
  readonly providerKey: string;
  buildMetadataFingerprint(payload: DistributionReleasePayload): string;
  submit(payload: DistributionReleasePayload): Promise<DistributionSubmissionResult>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhookEvent(rawBody: Buffer): DistributionWebhookEvent;
}

function canonicalReleaseJson(payload: DistributionReleasePayload): string {
  const canonicalRecordings = [...payload.recordings]
    .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber)
    .map((recording) => ({
      recordingId: recording.recordingId,
      isrc: recording.isrc,
      title: recording.title,
      primaryArtistName: recording.primaryArtistName,
      trackNumber: recording.trackNumber,
      discNumber: recording.discNumber
    }));
  return JSON.stringify({
    releaseId: payload.releaseId,
    providerKey: payload.providerKey,
    destinationKey: payload.destinationKey,
    title: payload.title,
    primaryArtistName: payload.primaryArtistName,
    releaseType: payload.releaseType,
    upc: payload.upc,
    originalReleaseDate: payload.originalReleaseDate,
    territories: [...payload.territories].sort(),
    recordings: canonicalRecordings
  });
}

/**
 * A provider that never leaves the process: it never calls out to a real
 * distributor, and its "acceptance" only happens if something later signs
 * and delivers a matching webhook event through the same secret. It exists
 * so the delivery job engine (state machine, idempotency, webhook auth,
 * replay defense) can be built and proven end-to-end before a real
 * contracted distribution provider is wired in. No route may register this
 * adapter for any providerKey other than 'sway_sandbox', and callers must
 * never surface a sandbox delivery's status as a real DSP confirmation.
 */
export function createSandboxDistributionAdapter(config: { secret: string }): DistributionAdapter & {
  signWebhookEvent(event: DistributionWebhookEvent): { rawBody: Buffer; signatureHeader: string };
} {
  const secret = config.secret;
  if (!secret) throw new Error('Sandbox distribution adapter requires a secret.');

  function sign(rawBody: Buffer): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  return {
    providerKey: 'sway_sandbox',
    buildMetadataFingerprint(payload) {
      return createHash('sha256').update(canonicalReleaseJson(payload)).digest('hex');
    },
    async submit(payload) {
      return { providerReleaseId: `sandbox-${payload.releaseId}-${randomUUID()}` };
    },
    verifyWebhookSignature(rawBody, signatureHeader) {
      if (!signatureHeader) return false;
      const expected = sign(rawBody);
      const expectedBuffer = Buffer.from(expected, 'hex');
      const providedBuffer = Buffer.from(signatureHeader, 'hex');
      if (expectedBuffer.length !== providedBuffer.length) return false;
      return timingSafeEqual(expectedBuffer, providedBuffer);
    },
    parseWebhookEvent(rawBody) {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      if (typeof parsed.providerEventId !== 'string' || !parsed.providerEventId) {
        throw new Error('Sandbox webhook event requires providerEventId.');
      }
      if (typeof parsed.providerReleaseId !== 'string' || !parsed.providerReleaseId) {
        throw new Error('Sandbox webhook event requires providerReleaseId.');
      }
      if (typeof parsed.destinationKey !== 'string' || !parsed.destinationKey) {
        throw new Error('Sandbox webhook event requires destinationKey.');
      }
      const allowedStatuses = new Set(['accepted', 'live', 'correction_pending', 'failed', 'taken_down']);
      if (!allowedStatuses.has(parsed.status)) {
        throw new Error(`Sandbox webhook event has unsupported status: ${parsed.status}`);
      }
      const destinationReleaseId = typeof parsed.destinationReleaseId === 'string' ? parsed.destinationReleaseId : null;
      if ((parsed.status === 'accepted' || parsed.status === 'live') && !destinationReleaseId) {
        throw new Error('Sandbox webhook event requires destinationReleaseId for accepted/live status.');
      }
      return {
        providerEventId: parsed.providerEventId,
        providerReleaseId: parsed.providerReleaseId,
        destinationKey: parsed.destinationKey,
        status: parsed.status,
        destinationReleaseId,
        error: typeof parsed.error === 'string' ? parsed.error : null
      };
    },
    signWebhookEvent(event) {
      const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
      return { rawBody, signatureHeader: sign(rawBody) };
    }
  };
}
