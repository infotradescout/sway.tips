/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TrackReference {
  id: string;
  title: string;
  artist: string;
  albumArt: string;
  genre?: string;
}

export interface CustomMenuItem {
  id: string;
  title: string;
  description: string;
  basePrice: number;
  iconName: string;
}

export interface BoostContribution {
  id: string;
  patronName: string;
  amount: number;
  timestamp: string;
  actorUserId?: string | null;
  clientRequestId?: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  idempotencyExpiresAt?: string;
  paymentId?: string | null;
  paymentIntentId?: string | null;
  paymentStatus?: string | null;
}

export interface PatronStatusReceiptRecord {
  receiptHash: string;
  issuedAt: string;
  expiresAt: string;
}

export type PatronRequestStatusCode = 'pending' | 'approved' | 'not_approved' | 'fulfilled';

export interface PatronRequestStatus {
  requestId: string;
  status: PatronRequestStatusCode;
}

export interface RequestItem {
  id: string;
  type: 'request' | 'tip';
  targetType: 'music' | 'custom' | 'straight_tip';
  title: string;          // Song title, menu item, or "Classic Tip"
  subtitle: string;       // Artist, description, or empty
  albumArt?: string;      // Optional URL
  sourceProvider?: string | null;
  spotifyUri?: string | null;
  spotifyUrl?: string | null;
  senderName: string;
  message?: string;
  amount: number;         // Total pool (original + boosts)
  holdAmount: number;     // Temporary amount field until real payment lifecycle lands
  platformFee: number;    // Accumulated platform fees ($1 per transaction/boost)
  sponsorCount: number;   // Number of different patrons funding this
  status: 'hold' | 'approved' | 'denied' | 'fulfilled';
  shadowBanned: boolean;  // Profanity filter flag
  hidden?: boolean;
  removed?: boolean;
  actorUserId?: string | null;
  lastMutationActorUserId?: string | null;
  createdAt: string;
  clientRequestId?: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  idempotencyExpiresAt?: string;
  patronDeviceIdHash?: string;
  gigId?: string;
  payloadHash?: string;
  amountCents?: number;
  currency?: string;
  paymentId?: string | null;
  paymentIntentId?: string | null;
  paymentStatus?: string | null;
  patronStatusReceipts?: PatronStatusReceiptRecord[];
  boosts: BoostContribution[];
}

export interface SetlistTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  albumArt?: string | null;
  spotifyUri?: string | null;
  spotifyUrl?: string | null;
  sourceKey: string;
  addedAt: string;
}

export interface RequestPreset {
  id: string;
  label: string;
  duration: number; // in minutes
  isSystem?: boolean;
}

export interface GigSession {
  status: 'inactive' | 'active' | 'ending' | 'closed';
  ownerActorUserId?: string | null;
  lastMutationActorUserId?: string | null;
  talentName: string;
  talentRole: 'DJ' | 'Bartender' | 'Performer';
  feeType: 'talent' | 'patron'; // Who pays the $1 platform fee
  minimumTip: number;           // Usually $5
  endGigTimerStartedAt: string | null; // Match timestamp for 5-minute Post-Gig closeout
  isFeatured: boolean;          // Featured Performer Status
  featuredExpiresAt: string | null; // Featured Expiration Timestamp
  featuredCost: number;        // Cost of featured promotion
  featuredDurationHours: number; // Selected duration in hours
  requestsOpen: boolean;       // Overall toggle status
  requestWindowMode: 'manual' | 'preset';
  requestWindowExpiresAt: string | null; // ISO timestamp
  requestWindowDuration: number | null; // duration in minutes
  requestWindowLabel: string | null; // Active preset label
  requestPresets: RequestPreset[]; // Buildable custom/system presets list
  // Operating posture for the room layer.
  operatingMode: 'manual' | 'open_call' | 'crowd_autopilot';
  // Song search scope for this room: performer's own synced library, the full
  // open catalog, or a performer-curated setlist for this occasion.
  searchScope: 'library' | 'catalog' | 'setlist';
  // When false, this room is a free event: tips are rejected, boosts become
  // free upvotes, and requests are created with no payment step at all.
  paymentsEnabled: boolean;
  totals: {
    totalTips: number;
    accumulatedFees: number;
    totalCount: number;
    topRequest: string;
  };
}

export interface PerformerProfile {
  id: string;
  name: string;
  role: 'DJ' | 'Bartender' | 'Performer';
  venueName: string;
  isFeatured: boolean;
  featuredExpiresAt: string | null;
  minimumTip: number;
  avatarUrl: string;
}

export interface ActiveRoomSummary {
  gigId: string;
  performerName: string;
  talentRole: 'DJ' | 'Bartender' | 'Performer';
  routePath: string;
  startedAt: string | null;
  requestCount: number;
}

export interface BackendState {
  session: GigSession;
  requests: RequestItem[];
  performers: PerformerProfile[];
  activeGigId: string | null;
}
