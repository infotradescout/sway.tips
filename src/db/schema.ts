import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['patron', 'performer', 'admin', 'support']);

export const performerOnboardingStatusEnum = pgEnum('performer_onboarding_status', [
  'created',
  'profile_started',
  'gig_ready',
  'payments_limited',
  'verification_required',
  'verified',
  'payouts_enabled',
  'restricted',
  'suspended'
]);

export const paymentAccountStatusEnum = pgEnum('payment_account_status', [
  'not_started',
  'created',
  'charges_enabled',
  'payouts_enabled',
  'restricted',
  'disabled'
]);

export const kycStatusEnum = pgEnum('kyc_status', [
  'not_required',
  'required',
  'submitted',
  'verified',
  'rejected'
]);

export const gigSessionStatusEnum = pgEnum('gig_session_status', [
  'draft',
  'scheduled',
  'active',
  'closeout_pending',
  'closed',
  'expired',
  'canceled'
]);

export const requestStatusEnum = pgEnum('request_status', [
  'submitted',
  'payment_pending',
  'payment_authorized',
  'held_for_review',
  'approved',
  'denied',
  'voided_or_refunded',
  'fulfilled',
  'captured',
  'paid_out',
  'disputed'
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'created',
  'payment_pending',
  'authorized',
  'captured',
  'voided',
  'refunded',
  'failed',
  'disputed',
  'paid_out'
]);

export const captureModeEnum = pgEnum('capture_mode', ['automatic', 'manual']);
export const refundStatusEnum = pgEnum('refund_status', ['not_refunded', 'pending', 'refunded', 'failed']);
export const payoutStatusEnum = pgEnum('payout_status', ['not_started', 'pending', 'paid_out', 'failed']);
export const moderationStatusEnum = pgEnum('moderation_status', ['allowed', 'held_for_review', 'blocked']);
export const pendingActionStatusEnum = pgEnum('pending_action_status', [
  'pending',
  'retrying',
  'reconciled',
  'expired',
  'failed'
]);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused', 'ended']);
export const attributionSourceEnum = pgEnum('attribution_source', ['creator_direct', 'sway_promoted']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email'),
  displayName: text('display_name'),
  passwordHash: text('password_hash'),
  // Collected at claim time (see claim_code flow in server.ts), stored as entered --
  // no SMS verification. Distinct from performer_public_profiles.bookingPhone, which
  // is public-facing fan/booking contact info, not an account field.
  phone: text('phone'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  role: userRoleEnum('role').notNull().default('patron'),
  ...timestamps
}, (table) => ({
  emailIdx: uniqueIndex('users_email_idx').on(table.email)
}));

export const performers = pgTable('performers', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  handle: text('handle'),
  displayName: text('display_name').notNull(),
  bio: text('bio'),
  isActive: boolean('is_active').notNull().default(false),
  onboardingStatus: performerOnboardingStatusEnum('onboarding_status').notNull().default('created'),
  paymentAccountStatus: paymentAccountStatusEnum('payment_account_status').notNull().default('not_started'),
  kycStatus: kycStatusEnum('kyc_status').notNull().default('not_required'),
  payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
  chargesEnabled: boolean('charges_enabled').notNull().default(false),
  stripeConnectedAccountId: text('stripe_connected_account_id'),
  lifetimeGrossVolume: integer('lifetime_gross_volume').notNull().default(0),
  payoutHoldReason: text('payout_hold_reason'),
  verificationRequiredAtAmount: integer('verification_required_at_amount').notNull().default(10000),
  ...timestamps
}, (table) => ({
  handleIdx: uniqueIndex('idx_performers_handle').on(table.handle).where(sql`${table.handle} is not null`),
  handleLowerIdx: uniqueIndex('idx_performers_handle_lower').on(sql`lower(${table.handle})`).where(sql`${table.handle} is not null`),
  handleNotReserved: check('performers_handle_not_reserved', sql`${table.handle} is null or lower(${table.handle}) not in ('admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover', 'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile', 'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway', 'talent', 'terms', 'www')`),
  ownerIdx: index('performers_owner_user_id_idx').on(table.ownerUserId)
}));

export const performerPublicProfiles = pgTable('performer_public_profiles', {
  performerId: uuid('performer_id').primaryKey().references(() => performers.id),
  headline: text('headline'),
  specialties: jsonb('specialties').$type<string[]>(),
  city: text('city'),
  avatarUrl: text('avatar_url'),
  bookingEmail: text('booking_email'),
  bookingPhone: text('booking_phone'),
  facebookUrl: text('facebook_url'),
  instagramUrl: text('instagram_url'),
  tiktokUrl: text('tiktok_url'),
  youtubeUrl: text('youtube_url'),
  soundcloudUrl: text('soundcloud_url'),
  websiteUrl: text('website_url'),
  featuredMedia: jsonb('featured_media'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  updatedAtIdx: index('performer_public_profiles_updated_at_idx').on(table.updatedAt)
}));

// Curated, read-only profile previews are deliberately separate from performers.
// A preview has no owner account, password, terms receipt, or private contact data.
// It becomes a normal performer profile only through the owner-controlled invite flow.
export const performerProfilePreviews = pgTable('performer_profile_previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  handle: text('handle').notNull(),
  claimedPerformerId: uuid('claimed_performer_id').references(() => performers.id),
  displayName: text('display_name').notNull(),
  bio: text('bio'),
  headline: text('headline'),
  specialties: jsonb('specialties').$type<string[]>(),
  city: text('city'),
  avatarUrl: text('avatar_url'),
  facebookUrl: text('facebook_url'),
  instagramUrl: text('instagram_url'),
  tiktokUrl: text('tiktok_url'),
  youtubeUrl: text('youtube_url'),
  soundcloudUrl: text('soundcloud_url'),
  websiteUrl: text('website_url'),
  links: jsonb('links'),
  featuredMedia: jsonb('featured_media'),
  metadata: jsonb('metadata'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
}, (table) => ({
  handleLowerIdx: uniqueIndex('performer_profile_previews_handle_lower_idx').on(sql`lower(${table.handle})`),
  claimedPerformerIdx: uniqueIndex('performer_profile_previews_claimed_performer_idx').on(table.claimedPerformerId),
  handleNotReserved: check('performer_profile_previews_handle_not_reserved', sql`lower(${table.handle}) not in ('admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover', 'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile', 'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway', 'talent', 'terms', 'www')`),
  activeIdx: index('performer_profile_previews_active_idx').on(table.isActive)
}));

export const performerProfileLinks = pgTable('performer_profile_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  description: text('description'),
  url: text('url').notNull(),
  kind: text('kind').notNull().default('other'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
}, (table) => ({
  performerSortIdx: index('performer_profile_links_performer_sort_idx').on(table.performerId, table.sortOrder),
  performerActiveIdx: index('performer_profile_links_performer_active_idx').on(table.performerId, table.isActive)
}));

export const performerPartnerEntitlements = pgTable('performer_partner_entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  grantedByUserId: uuid('granted_by_user_id').notNull().references(() => users.id),
  partnerKind: text('partner_kind').notNull().default('brand'),
  termsVersion: text('terms_version').notNull(),
  termsHash: text('terms_hash').notNull(),
  termsText: text('terms_text').notNull(),
  termsSnapshot: jsonb('terms_snapshot').$type<{
    guarantee: string;
    publicProfileHostingFeeCents: number;
    performerSubscriptionFeeCents: number;
    paidInteractionPlatformFeeCents: number;
    externalChargesExcluded: string[];
  }>().notNull(),
  note: text('note'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  performerKindIdx: uniqueIndex('performer_partner_entitlements_performer_kind_idx').on(table.performerId, table.partnerKind),
  termsVersionIdx: index('performer_partner_entitlements_terms_version_idx').on(table.termsVersion)
}));

export const performerPartnerEntitlementStatusEvents = pgTable('performer_partner_entitlement_status_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  entitlementId: uuid('entitlement_id').notNull().references(() => performerPartnerEntitlements.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  status: text('status').notNull(),
  reason: text('reason'),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  entitlementCreatedIdx: index('performer_partner_entitlement_status_events_entitlement_created_idx').on(table.entitlementId, table.createdAt),
  performerCreatedIdx: index('performer_partner_entitlement_status_events_performer_created_idx').on(table.performerId, table.createdAt),
  statusAllowed: check('performer_partner_entitlement_status_events_status_allowed', sql`${table.status} in ('active', 'suspended')`)
}));

export const performerPartnerTermsAcceptances = pgTable('performer_partner_terms_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  entitlementId: uuid('entitlement_id').notNull().references(() => performerPartnerEntitlements.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  accountUserId: uuid('account_user_id').notNull().references(() => users.id),
  termsVersion: text('terms_version').notNull(),
  termsHash: text('terms_hash').notNull(),
  termsText: text('terms_text').notNull(),
  termsSnapshot: jsonb('terms_snapshot').$type<{
    guarantee: string;
    publicProfileHostingFeeCents: number;
    performerSubscriptionFeeCents: number;
    paidInteractionPlatformFeeCents: number;
    externalChargesExcluded: string[];
  }>().notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  immutableReceiptIdx: uniqueIndex('performer_partner_terms_acceptances_receipt_idx').on(
    table.entitlementId,
    table.accountUserId,
    table.termsHash
  ),
  performerAcceptedIdx: index('performer_partner_terms_acceptances_performer_accepted_idx').on(table.performerId, table.acceptedAt)
}));

export const performerMemberships = pgTable('performer_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  performerUserIdx: uniqueIndex('performer_memberships_performer_user_idx').on(table.performerId, table.userId)
}));

export const gigSessions = pgTable('gig_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  ownerActorUserId: uuid('owner_actor_user_id').references(() => users.id),
  lastMutationActorUserId: uuid('last_mutation_actor_user_id').references(() => users.id),
  status: gigSessionStatusEnum('status').notNull().default('draft'),
  title: text('title'),
  venueName: text('venue_name'),
  runtimeSessionState: jsonb('runtime_session_state'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  manualCloseoutStartedAt: timestamp('manual_closeout_started_at', { withTimezone: true }),
  manualCloseoutCompletedAt: timestamp('manual_closeout_completed_at', { withTimezone: true }),
  autoCloseoutAt: timestamp('auto_closeout_at', { withTimezone: true }).notNull(),
  autoCloseoutReason: text('auto_closeout_reason'),
  closeoutPolicy: text('closeout_policy').notNull().default('max_started_at_4h_or_scheduled_end_at_30m'),
  ...timestamps
}, (table) => ({
  performerStatusIdx: index('gig_sessions_performer_status_idx').on(table.performerId, table.status),
  autoCloseoutIdx: index('gig_sessions_auto_closeout_at_idx').on(table.autoCloseoutAt)
}));

export const gigAccessGrants = pgTable('gig_access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  accessLevel: text('access_level').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  gigUserIdx: uniqueIndex('gig_access_grants_gig_user_idx').on(table.gigId, table.userId)
}));

export const activeRoomRegistry = pgTable('active_room_registry', {
  gigId: uuid('gig_id').primaryKey().references(() => gigSessions.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  ownerActorUserId: uuid('owner_actor_user_id').references(() => users.id),
  talentName: text('talent_name').notNull().default(''),
  talentRole: text('talent_role').notNull().default('Performer'),
  routePath: text('route_path').notNull(),
  registryStatus: text('registry_status').notNull().default('active'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
}, (table) => ({
  statusActivityIdx: index('active_room_registry_status_activity_idx').on(table.registryStatus, table.lastActivityAt),
  performerIdx: index('active_room_registry_performer_idx').on(table.performerId)
}));

export const performerSessions = pgTable('performer_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  issuedBy: uuid('issued_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashIdx: uniqueIndex('performer_sessions_token_hash_idx').on(table.tokenHash),
  actorExpiresIdx: index('performer_sessions_actor_expires_idx').on(table.actorUserId, table.expiresAt)
}));

export const performerLoginChallenges = pgTable('performer_login_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetEmail: text('target_email').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  challengeType: text('challenge_type').notNull().default('login'),
  tokenHash: text('token_hash').notNull(),
  challengeMetadata: jsonb('challenge_metadata'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  sendCount: integer('send_count').notNull().default(1),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  requesterIpHash: text('requester_ip_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashIdx: uniqueIndex('performer_login_challenges_token_hash_idx').on(table.tokenHash),
  actorExpiresIdx: index('performer_login_challenges_actor_expires_idx').on(table.actorUserId, table.expiresAt),
  requestBucketIdx: index('performer_login_challenges_request_bucket_idx').on(table.requesterIpHash, table.targetEmail, table.requestedAt)
}));

export const performerLibrarySources = pgTable('performer_library_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  sourceKey: text('source_key').notNull(),
  sourceLabel: text('source_label').notNull(),
  syncKeyHash: text('sync_key_hash').notNull(),
  syncKeyPreview: text('sync_key_preview').notNull(),
  connectionStatus: text('connection_status').notNull().default('active'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  performerSourceIdx: uniqueIndex('performer_library_sources_performer_source_idx').on(table.performerId, table.sourceKey),
  syncKeyHashIdx: uniqueIndex('performer_library_sources_sync_key_hash_idx').on(table.syncKeyHash)
}));

export const performerLibraryTracks = pgTable('performer_library_tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  sourceKey: text('source_key').notNull(),
  sourceLabel: text('source_label').notNull(),
  externalTrackId: text('external_track_id').notNull(),
  title: text('title').notNull(),
  artist: text('artist').notNull(),
  album: text('album'),
  artworkUrl: text('artwork_url'),
  searchableText: text('searchable_text').notNull(),
  metadata: jsonb('metadata'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
}, (table) => ({
  performerSourceTrackIdx: uniqueIndex('performer_library_tracks_performer_source_track_idx').on(
    table.performerId,
    table.sourceKey,
    table.externalTrackId
  ),
  performerSearchIdx: index('performer_library_tracks_performer_search_idx').on(table.performerId, table.lastSeenAt)
}));

export const performerMusicSourceConnections = pgTable('performer_music_source_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  providerKey: text('provider_key').notNull(),
  providerDisplayName: text('provider_display_name').notNull(),
  sourceMode: text('source_mode').notNull(),
  connectionStatus: text('connection_status').notNull().default('not_connected'),
  authStatus: text('auth_status').notNull().default('not_connected'),
  capabilitySnapshot: jsonb('capability_snapshot').notNull(),
  externalAccountId: text('external_account_id'),
  externalAccountLabel: text('external_account_label'),
  tokenVaultRef: text('token_vault_ref'),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  lastCapabilityCheckedAt: timestamp('last_capability_checked_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  performerProviderAccountIdx: uniqueIndex('performer_music_source_connections_provider_account_idx').on(
    table.performerId,
    table.providerKey,
    table.externalAccountId
  ),
  performerProviderStatusIdx: index('performer_music_source_connections_provider_status_idx').on(
    table.performerId,
    table.providerKey,
    table.connectionStatus
  )
}));

export const performerSetlistTracks = pgTable('performer_setlist_tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  sourceKey: text('source_key').notNull().default('manual'),
  externalTrackId: text('external_track_id'),
  title: text('title').notNull(),
  artist: text('artist').notNull(),
  album: text('album'),
  artworkUrl: text('artwork_url'),
  spotifyUri: text('spotify_uri'),
  spotifyUrl: text('spotify_url'),
  searchableText: text('searchable_text').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
}, (table) => ({
  performerSearchIdx: index('performer_setlist_tracks_performer_search_idx').on(table.performerId, table.addedAt)
}));

export const promotionCampaigns = pgTable('promotion_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  campaignCode: text('campaign_code').notNull(),
  label: text('label').notNull(),
  commissionBps: integer('commission_bps').notNull(),
  status: campaignStatusEnum('status').notNull().default('draft'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  codeIdx: uniqueIndex('promotion_campaigns_code_idx').on(table.campaignCode),
  performerStatusIdx: index('promotion_campaigns_performer_status_idx').on(table.performerId, table.status)
}));

export const requests = pgTable('requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  patronUserId: uuid('patron_user_id').references(() => users.id),
  lastMutationActorUserId: uuid('last_mutation_actor_user_id').references(() => users.id),
  clientRequestId: text('client_request_id').notNull(),
  status: requestStatusEnum('status').notNull().default('submitted'),
  requestType: text('request_type').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  message: text('message'),
  runtimeRequestState: jsonb('runtime_request_state'),
  ...timestamps
}, (table) => ({
  gigStatusIdx: index('requests_gig_status_idx').on(table.gigId, table.status),
  clientRequestIdx: uniqueIndex('requests_client_request_id_idx').on(table.clientRequestId)
}));

export const requestBoosts = pgTable('request_boosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => requests.id),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  patronUserId: uuid('patron_user_id').references(() => users.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  status: requestStatusEnum('status').notNull().default('submitted'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  runtimeBoostState: jsonb('runtime_boost_state'),
  ...timestamps
}, (table) => ({
  requestIdx: index('request_boosts_request_id_idx').on(table.requestId),
  gigIdx: index('request_boosts_gig_id_idx').on(table.gigId)
}));

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  requestId: uuid('request_id').references(() => requests.id),
  requestBoostId: uuid('request_boost_id').references(() => requestBoosts.id),
  paymentStatus: paymentStatusEnum('payment_status').notNull().default('created'),
  processor: text('processor').notNull(),
  processorPaymentIntentId: text('processor_payment_intent_id'),
  processorChargeId: text('processor_charge_id'),
  amountSubtotal: integer('amount_subtotal').notNull(),
  // Sway's actual commission collected (== Stripe application_fee_amount), regardless of
  // whether it was added to the patron's charge or deducted from the performer's payout.
  platformFee: integer('platform_fee').notNull().default(0),
  amountTotal: integer('amount_total').notNull(),
  currency: text('currency').notNull().default('USD'),
  attributionSource: attributionSourceEnum('attribution_source').notNull().default('creator_direct'),
  campaignId: uuid('campaign_id').references(() => promotionCampaigns.id),
  // The campaign's NEGOTIATED rate at time of sale -- not necessarily the effective
  // rate collected. A Brand Partner's fee cap (resolveSwayPlatformFeePolicyForGig) can
  // clamp platformFee below what this bps would imply on amountSubtotal. platformFee is
  // always the source of truth for what was actually collected; never derive financial
  // totals from commissionBpsApplied.
  commissionBpsApplied: integer('commission_bps_applied'),
  captureMode: captureModeEnum('capture_mode').notNull().default('manual'),
  refundStatus: refundStatusEnum('refund_status').notNull().default('not_refunded'),
  payoutStatus: payoutStatusEnum('payout_status').notNull().default('not_started'),
  ...timestamps
}, (table) => ({
  gigStatusIdx: index('payments_gig_status_idx').on(table.gigId, table.paymentStatus),
  processorIntentIdx: uniqueIndex('payments_processor_payment_intent_idx').on(table.processorPaymentIntentId),
  campaignIdx: index('payments_campaign_id_idx').on(table.campaignId)
}));

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  processor: text('processor').notNull(),
  processorEventId: text('processor_event_id'),
  eventType: text('event_type').notNull(),
  previousStatus: paymentStatusEnum('previous_status'),
  nextStatus: paymentStatusEnum('next_status'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  paymentIdx: index('payment_events_payment_id_idx').on(table.paymentId),
  processorEventIdx: uniqueIndex('payment_events_processor_event_idx').on(table.processorEventId)
}));

export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  paymentId: uuid('payment_id').references(() => payments.id),
  payoutStatus: payoutStatusEnum('payout_status').notNull().default('not_started'),
  processor: text('processor'),
  processorPayoutId: text('processor_payout_id'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  ...timestamps
}, (table) => ({
  performerStatusIdx: index('payouts_performer_status_idx').on(table.performerId, table.payoutStatus)
}));

export const moderationEvents = pgTable('moderation_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  status: moderationStatusEnum('status').notNull(),
  reason: text('reason'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  entityIdx: index('moderation_events_entity_idx').on(table.entityType, table.entityId)
}));

export const activeBlocks = pgTable('active_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').notNull(),
  normalizedValue: text('normalized_value').notNull(),
  reason: text('reason').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  status: text('status').notNull().default('active'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  scopeValueStatusIdx: uniqueIndex('active_blocks_scope_value_status_idx').on(table.scope, table.normalizedValue, table.status),
  activeLookupIdx: index('active_blocks_scope_value_idx').on(table.scope, table.normalizedValue)
}));

export const auditEvents = pgTable('audit_events', {
  eventId: uuid('event_id').primaryKey().defaultRandom(),
  actorType: text('actor_type').notNull(),
  actorId: uuid('actor_id'),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  eventType: text('event_type').notNull(),
  previousStatus: text('previous_status'),
  nextStatus: text('next_status'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  entityIdx: index('audit_events_entity_idx').on(table.entityType, table.entityId),
  createdAtIdx: index('audit_events_created_at_idx').on(table.createdAt)
}));

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: text('idempotency_key').notNull(),
  patronDeviceIdHash: text('patron_device_id_hash').notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  sessionId: text('session_id'),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  actionType: text('action_type').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  targetEntityType: text('target_entity_type'),
  targetEntityId: text('target_entity_id'),
  payloadHash: text('payload_hash').notNull(),
  intentFingerprint: text('intent_fingerprint').notNull(),
  firstResponseStatus: integer('first_response_status'),
  firstResponseBody: jsonb('first_response_body'),
  firstResponseBodyHash: text('first_response_body_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps
}, (table) => ({
  keyIdx: uniqueIndex('idempotency_keys_key_idx').on(table.idempotencyKey),
  fingerprintIdx: index('idempotency_keys_intent_fingerprint_idx').on(table.intentFingerprint),
  expiresAtIdx: index('idempotency_keys_expires_at_idx').on(table.expiresAt)
}));

export const clientPendingActions = pgTable('client_pending_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientRequestId: text('client_request_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  actionType: text('action_type').notNull(),
  payloadHash: text('payload_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  status: pendingActionStatusEnum('status').notNull().default('pending'),
  lastError: text('last_error')
}, (table) => ({
  clientRequestIdx: uniqueIndex('client_pending_actions_client_request_id_idx').on(table.clientRequestId),
  idempotencyKeyIdx: index('client_pending_actions_idempotency_key_idx').on(table.idempotencyKey),
  expiresAtIdx: index('client_pending_actions_expires_at_idx').on(table.expiresAt)
}));
