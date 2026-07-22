import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
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

// Phase 2 Slice 1: every account (patron or performer) is the same `users`
// row. Pro Mode is an activatable state on that row, not a separate account
// type. 'disabled' is the universal starting point for a patron/listener
// signup; performer signup moves straight to 'onboarding'. 'suspended' and
// 'revoked' are administrative-only transitions (see proModeStatusEvents).
export const proModeStatusEnum = pgEnum('pro_mode_status', ['disabled', 'onboarding', 'active', 'suspended', 'revoked']);

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
  proModeStatus: proModeStatusEnum('pro_mode_status').notNull().default('disabled'),
  proModeStatusChangedAt: timestamp('pro_mode_status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
}, (table) => ({
  emailIdx: uniqueIndex('users_email_idx').on(table.email)
}));

// Append-only audit trail for every Pro Mode state transition. Mirrors the
// performerPartnerEntitlementStatusEvents pattern: immutable once written
// (see the 0022 migration trigger).
//
// userId/actorUserId are deliberately plain uuid columns, not foreign keys to
// users.id (see 0022). Sway's account-deletion path retains the users row
// (email/name/password scrubbed, row kept) so a live FK would not normally be
// at risk there -- but a real hard DELETE of a users row does exist elsewhere
// (signup rollback when verification-email delivery fails, in server.ts),
// and a live FK there would make an already-committed Pro Mode event block
// that unrelated cleanup. These columns hold immutable, pseudonymous
// historical identifiers on purpose: once written, they must never be
// updated, deleted, or cascaded away, even if the account they reference is
// later scrubbed or removed. They never store email, name, phone, or other
// direct personal data.
export const proModeStatusEvents = pgTable('pro_mode_status_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  previousStatus: text('previous_status'),
  nextStatus: text('next_status').notNull(),
  reason: text('reason').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  userCreatedIdx: index('pro_mode_status_events_user_created_idx').on(table.userId, table.createdAt),
  nextStatusAllowed: check('pro_mode_status_events_next_status_allowed', sql`${table.nextStatus} in ('disabled', 'onboarding', 'active', 'suspended', 'revoked')`)
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

// --- Audio publishing foundation (ported from agent/audio-publishing-foundation as migration 0023) ---
export const audioProjectKindEnum = pgEnum('audio_project_kind', [
  'music',
  'comedy',
  'podcast',
  'other_audio'
]);

export const audioAssetIntegrityStatusEnum = pgEnum('audio_asset_integrity_status', [
  'pending',
  'verified',
  'quarantined',
  'rejected'
]);

export const audioFilePairingPurposeEnum = pgEnum('audio_file_pairing_purpose', [
  'request_files',
  'send_files'
]);

export const musicDistributionModeEnum = pgEnum('music_distribution_mode', [
  'private',
  'sway_only',
  'sway_first',
  'everywhere'
]);

export const musicReleaseStatusEnum = pgEnum('music_release_status', [
  'draft',
  'rights_review',
  'ready',
  'scheduled',
  'published',
  'takedown_requested',
  'taken_down',
  'blocked'
]);

export const catalogTransferStatusEnum = pgEnum('catalog_transfer_status', [
  'intake',
  'source_snapshot',
  'rights_review',
  'artist_identity_mapped',
  'parity_locked',
  'new_delivery_staged',
  'store_processing',
  'overlap_live',
  'store_match_verified',
  'artist_cutover_approved',
  'old_provider_takedown',
  'cutover_monitoring',
  'tail_royalty_reconciliation',
  'complete',
  'rights_blocked',
  'parity_failed',
  'mapping_failed',
  'track_link_failed',
  'content_id_conflict',
  'revenue_gap',
  'canceled'
]);

export const audioProjects = pgTable('audio_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  projectKind: audioProjectKindEnum('project_kind').notNull().default('music'),
  status: text('status').notNull().default('active'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  performerStatusIdx: index('audio_projects_performer_status_idx').on(table.performerId, table.status),
  idPerformerIdx: uniqueIndex('audio_projects_id_performer_idx').on(table.id, table.performerId),
  statusAllowed: check('audio_projects_status_allowed', sql`${table.status} in ('active', 'archived')`)
}));

export const audioProjectAccessGrants = pgTable('audio_project_access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id, { onDelete: 'cascade' }),
  granteeUserId: uuid('grantee_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  canUploadVersions: boolean('can_upload_versions').notNull().default(false),
  canDownloadOriginals: boolean('can_download_originals').notNull().default(false),
  canComment: boolean('can_comment').notNull().default(true),
  canApprove: boolean('can_approve').notNull().default(false),
  canManageRelease: boolean('can_manage_release').notNull().default(false),
  canManageAccess: boolean('can_manage_access').notNull().default(false),
  grantedByUserId: uuid('granted_by_user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
  revocationReason: text('revocation_reason'),
  ...timestamps
}, (table) => ({
  activeProjectUserIdx: uniqueIndex('audio_project_access_grants_active_project_user_idx').on(table.projectId, table.granteeUserId).where(sql`${table.revokedAt} is null`),
  idProjectGranteeIdx: uniqueIndex('audio_project_access_grants_id_project_grantee_idx').on(table.id, table.projectId, table.granteeUserId),
  idProjectManagerIdx: uniqueIndex('audio_project_access_grants_id_project_manager_idx').on(table.id, table.projectId, table.granteeUserId, table.canManageAccess),
  userRevokedIdx: index('audio_project_access_grants_user_revoked_idx').on(table.granteeUserId, table.revokedAt),
  roleAllowed: check('audio_project_access_grants_role_allowed', sql`${table.role} in ('owner', 'artist', 'producer', 'engineer', 'collaborator', 'reviewer')`),
  revocationComplete: check('audio_project_access_grants_revocation_complete', sql`(${table.revokedAt} is null and ${table.revokedByUserId} is null) or (${table.revokedAt} is not null and ${table.revokedByUserId} is not null)`)
}));

export const audioProjectInvitations = pgTable('audio_project_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id, { onDelete: 'cascade' }),
  targetEmailNormalized: text('target_email_normalized').notNull(),
  tokenHash: text('token_hash').notNull(),
  role: text('role').notNull(),
  permissionSnapshot: jsonb('permission_snapshot').$type<{
    uploadVersions: boolean;
    downloadOriginals: boolean;
    comment: boolean;
    approve: boolean;
    manageRelease: boolean;
    manageAccess: boolean;
  }>().notNull(),
  invitedByUserId: uuid('invited_by_user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashIdx: uniqueIndex('audio_project_invitations_token_hash_idx').on(table.tokenHash),
  projectEmailIdx: index('audio_project_invitations_project_email_idx').on(table.projectId, table.targetEmailNormalized),
  roleAllowed: check('audio_project_invitations_role_allowed', sql`${table.role} in ('artist', 'producer', 'engineer', 'collaborator', 'reviewer')`),
  targetEmailNormalized: check('audio_project_invitations_target_email_normalized', sql`${table.targetEmailNormalized} = lower(trim(${table.targetEmailNormalized})) and length(${table.targetEmailNormalized}) > 3`),
  tokenHashValid: check('audio_project_invitations_token_hash_valid', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  expiryValid: check('audio_project_invitations_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
  permissionSnapshotRequired: check('audio_project_invitations_permission_snapshot_required', sql`jsonb_typeof(${table.permissionSnapshot}) = 'object' and ${table.permissionSnapshot} <> '{}'::jsonb`),
  acceptanceComplete: check('audio_project_invitations_acceptance_complete', sql`(${table.acceptedAt} is null and ${table.acceptedByUserId} is null) or (${table.acceptedAt} is not null and ${table.acceptedByUserId} is not null)`),
  revocationComplete: check('audio_project_invitations_revocation_complete', sql`(${table.revokedAt} is null and ${table.revokedByUserId} is null) or (${table.revokedAt} is not null and ${table.revokedByUserId} is not null)`),
  acceptedOrRevoked: check('audio_project_invitations_accepted_or_revoked', sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null)`)
}));

export const audioAssets = pgTable('audio_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  assetKind: text('asset_kind').notNull(),
  provenanceType: text('provenance_type').notNull().default('user_upload'),
  status: text('status').notNull().default('active'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  projectStatusIdx: index('audio_assets_project_status_idx').on(table.projectId, table.status),
  idProjectIdx: uniqueIndex('audio_assets_id_project_idx').on(table.id, table.projectId),
  kindAllowed: check('audio_assets_kind_allowed', sql`${table.assetKind} in ('master_audio', 'mix', 'stem', 'session', 'artwork', 'lyrics', 'video', 'document', 'other')`),
  statusAllowed: check('audio_assets_status_allowed', sql`${table.status} in ('active', 'archived', 'restricted')`)
}));

export const audioUploadSessions = pgTable('audio_upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id),
  assetId: uuid('asset_id').references(() => audioAssets.id),
  initiatedByUserId: uuid('initiated_by_user_id').notNull().references(() => users.id),
  idempotencyKey: text('idempotency_key').notNull(),
  storageProvider: text('storage_provider').notNull(),
  storageBucket: text('storage_bucket').notNull(),
  providerUploadId: text('provider_upload_id').notNull(),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename').notNull(),
  expectedMimeType: text('expected_mime_type').notNull(),
  expectedByteSize: bigint('expected_byte_size', { mode: 'number' }).notNull(),
  expectedSha256: text('expected_sha256').notNull(),
  partSizeBytes: integer('part_size_bytes').notNull(),
  uploadStatus: text('upload_status').notNull().default('initiated'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  providerUploadIdx: uniqueIndex('audio_upload_sessions_provider_upload_idx').on(table.storageProvider, table.providerUploadId),
  projectIdempotencyIdx: uniqueIndex('audio_upload_sessions_project_idempotency_idx').on(table.projectId, table.idempotencyKey),
  idProjectIdx: uniqueIndex('audio_upload_sessions_id_project_idx').on(table.id, table.projectId),
  idExpectedIdentityIdx: uniqueIndex('audio_upload_sessions_id_expected_identity_idx').on(table.id, table.expectedSha256, table.expectedByteSize),
  projectStatusIdx: index('audio_upload_sessions_project_status_idx').on(table.projectId, table.uploadStatus),
  cleanupIdx: index('audio_upload_sessions_cleanup_idx').on(table.uploadStatus, table.expiresAt),
  expectedByteSizeValid: check('audio_upload_sessions_expected_byte_size_valid', sql`${table.expectedByteSize} > 0`),
  expectedShaValid: check('audio_upload_sessions_expected_sha_valid', sql`${table.expectedSha256} ~ '^[0-9a-f]{64}$'`),
  statusAllowed: check('audio_upload_sessions_status_allowed', sql`${table.uploadStatus} in ('initiated', 'uploading', 'uploaded', 'verifying', 'completed', 'quarantined', 'rejected', 'aborted', 'expired')`),
  completionCoherent: check('audio_upload_sessions_completion_coherent', sql`(${table.uploadStatus} = 'completed' and ${table.completedAt} is not null) or (${table.uploadStatus} <> 'completed' and ${table.completedAt} is null)`),
  assetProjectFk: foreignKey({
    columns: [table.assetId, table.projectId],
    foreignColumns: [audioAssets.id, audioAssets.projectId],
    name: 'audio_upload_sessions_asset_project_fk'
  })
}));

export const audioUploadParts = pgTable('audio_upload_parts', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploadSessionId: uuid('upload_session_id').notNull().references(() => audioUploadSessions.id, { onDelete: 'cascade' }),
  partNumber: integer('part_number').notNull(),
  byteSize: integer('byte_size').notNull(),
  providerEtag: text('provider_etag').notNull(),
  providerChecksum: text('provider_checksum'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  sessionPartIdx: uniqueIndex('audio_upload_parts_session_part_idx').on(table.uploadSessionId, table.partNumber),
  partValid: check('audio_upload_parts_part_valid', sql`${table.partNumber} > 0 and ${table.byteSize} > 0`)
}));

export const audioProjectAssetVersions = pgTable('audio_project_asset_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  assetId: uuid('asset_id').notNull().references(() => audioAssets.id),
  uploadedByUserId: uuid('uploaded_by_user_id').notNull().references(() => users.id),
  uploadSessionId: uuid('upload_session_id').notNull().references(() => audioUploadSessions.id),
  versionNumber: integer('version_number').notNull(),
  originalFilename: text('original_filename').notNull(),
  storageProvider: text('storage_provider').notNull(),
  storageBucket: text('storage_bucket').notNull(),
  storageKey: text('storage_key').notNull(),
  providerVersionId: text('provider_version_id'),
  mimeType: text('mime_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  durationMs: integer('duration_ms'),
  codec: text('codec'),
  sampleRateHz: integer('sample_rate_hz'),
  bitDepth: integer('bit_depth'),
  channelCount: integer('channel_count'),
  integrityStatus: audioAssetIntegrityStatusEnum('integrity_status').notNull(),
  integrityVerifierKey: text('integrity_verifier_key').notNull(),
  integrityVerifiedAt: timestamp('integrity_verified_at', { withTimezone: true }).notNull(),
  integrityEvidence: jsonb('integrity_evidence').notNull(),
  originalPreserved: boolean('original_preserved').notNull().default(true),
  metadata: jsonb('metadata'),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  assetVersionIdx: uniqueIndex('audio_project_asset_versions_asset_version_idx').on(table.assetId, table.versionNumber),
  idProjectIdx: uniqueIndex('audio_project_asset_versions_id_project_idx').on(table.id, table.projectId),
  idProjectShaIdx: uniqueIndex('audio_project_asset_versions_id_project_sha_idx').on(table.id, table.projectId, table.sha256),
  idPerformerIdx: uniqueIndex('audio_project_asset_versions_id_performer_idx').on(table.id, table.performerId),
  storageObjectIdx: uniqueIndex('audio_project_asset_versions_storage_object_idx').on(table.storageProvider, table.storageBucket, table.storageKey),
  projectCreatedIdx: index('audio_project_asset_versions_project_created_idx').on(table.projectId, table.createdAt),
  byteSizeValid: check('audio_project_asset_versions_byte_size_valid', sql`${table.byteSize} > 0`),
  versionValid: check('audio_project_asset_versions_version_valid', sql`${table.versionNumber} > 0`),
  shaValid: check('audio_project_asset_versions_sha_valid', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  originalRequired: check('audio_project_asset_versions_original_required', sql`${table.originalPreserved} = true`),
  integrityVerified: check('audio_project_asset_versions_integrity_verified', sql`${table.integrityStatus} = 'verified'`),
  integrityEvidenceRequired: check('audio_project_asset_versions_integrity_evidence_required', sql`jsonb_typeof(${table.integrityEvidence}) = 'object' and ${table.integrityEvidence} <> '{}'::jsonb`),
  audioMetadataValid: check('audio_project_asset_versions_audio_metadata_valid', sql`(${table.durationMs} is null or ${table.durationMs} > 0) and (${table.sampleRateHz} is null or ${table.sampleRateHz} > 0) and (${table.bitDepth} is null or ${table.bitDepth} > 0) and (${table.channelCount} is null or ${table.channelCount} > 0)`),
  projectPerformerFk: foreignKey({
    columns: [table.projectId, table.performerId],
    foreignColumns: [audioProjects.id, audioProjects.performerId],
    name: 'audio_project_asset_versions_project_performer_fk'
  }),
  assetProjectFk: foreignKey({
    columns: [table.assetId, table.projectId],
    foreignColumns: [audioAssets.id, audioAssets.projectId],
    name: 'audio_project_asset_versions_asset_project_fk'
  }),
  uploadProjectFk: foreignKey({
    columns: [table.uploadSessionId, table.projectId],
    foreignColumns: [audioUploadSessions.id, audioUploadSessions.projectId],
    name: 'audio_project_asset_versions_upload_project_fk'
  }),
  uploadIdentityFk: foreignKey({
    columns: [table.uploadSessionId, table.sha256, table.byteSize],
    foreignColumns: [audioUploadSessions.id, audioUploadSessions.expectedSha256, audioUploadSessions.expectedByteSize],
    name: 'audio_project_asset_versions_upload_identity_fk'
  })
}));

export const audioAssetDerivatives = pgTable('audio_asset_derivatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceAssetVersionId: uuid('source_asset_version_id').notNull().references(() => audioProjectAssetVersions.id, { onDelete: 'cascade' }),
  derivativeKind: text('derivative_kind').notNull(),
  storageProvider: text('storage_provider').notNull(),
  storageBucket: text('storage_bucket').notNull(),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  sourceKindIdx: index('audio_asset_derivatives_source_kind_idx').on(table.sourceAssetVersionId, table.derivativeKind),
  storageObjectIdx: uniqueIndex('audio_asset_derivatives_storage_object_idx').on(table.storageProvider, table.storageBucket, table.storageKey),
  shaValid: check('audio_asset_derivatives_sha_valid', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  byteSizeValid: check('audio_asset_derivatives_byte_size_valid', sql`${table.byteSize} > 0`),
  kindAllowed: check('audio_asset_derivatives_kind_allowed', sql`${table.derivativeKind} in ('preview_stream', 'waveform', 'transcript', 'thumbnail', 'continuum_source', 'continuum_render')`)
}));

// File connection QRs are intentionally separate from the static Sway room QR.
// A QR token is consumed once to create this durable user-to-user connection;
// the connection remains active until one of its members explicitly revokes it.
export const audioFileConnections = pgTable('audio_file_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberOneUserId: uuid('member_one_user_id').notNull().references(() => users.id),
  memberTwoUserId: uuid('member_two_user_id').notNull().references(() => users.id),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdFromPurpose: audioFilePairingPurposeEnum('created_from_purpose').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
  revocationReason: text('revocation_reason'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  activeMemberPairIdx: uniqueIndex('audio_file_connections_active_member_pair_idx')
    .on(table.memberOneUserId, table.memberTwoUserId)
    .where(sql`${table.revokedAt} is null`),
  idMembersIdx: uniqueIndex('audio_file_connections_id_members_idx').on(table.id, table.memberOneUserId, table.memberTwoUserId),
  memberOneRevokedIdx: index('audio_file_connections_member_one_revoked_idx').on(table.memberOneUserId, table.revokedAt),
  memberTwoRevokedIdx: index('audio_file_connections_member_two_revoked_idx').on(table.memberTwoUserId, table.revokedAt),
  canonicalPairRequired: check('audio_file_connections_canonical_pair_required', sql`${table.memberOneUserId}::text < ${table.memberTwoUserId}::text`),
  creatorMustBeMember: check('audio_file_connections_creator_must_be_member', sql`${table.createdByUserId} = ${table.memberOneUserId} or ${table.createdByUserId} = ${table.memberTwoUserId}`),
  revokerMustBeMember: check('audio_file_connections_revoker_must_be_member', sql`${table.revokedByUserId} is null or ${table.revokedByUserId} = ${table.memberOneUserId} or ${table.revokedByUserId} = ${table.memberTwoUserId}`),
  revocationComplete: check('audio_file_connections_revocation_complete', sql`(${table.revokedAt} is null and ${table.revokedByUserId} is null) or (${table.revokedAt} is not null and ${table.revokedByUserId} is not null)`)
}));

export const audioFilePairingTokens = pgTable('audio_file_pairing_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  purpose: audioFilePairingPurposeEnum('purpose').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  tokenHash: text('token_hash').notNull(),
  connectionLabel: text('connection_label'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedByUserId: uuid('consumed_by_user_id').references(() => users.id),
  connectionId: uuid('connection_id').references(() => audioFileConnections.id),
  connectionMemberOneUserId: uuid('connection_member_one_user_id'),
  connectionMemberTwoUserId: uuid('connection_member_two_user_id'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashIdx: uniqueIndex('audio_file_pairing_tokens_token_hash_idx').on(table.tokenHash),
  creatorIdempotencyIdx: uniqueIndex('audio_file_pairing_tokens_creator_idempotency_idx').on(table.createdByUserId, table.idempotencyKey),
  creatorExpiryIdx: index('audio_file_pairing_tokens_creator_expiry_idx').on(table.createdByUserId, table.expiresAt),
  tokenHashValid: check('audio_file_pairing_tokens_token_hash_valid', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  expiryValid: check('audio_file_pairing_tokens_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
  consumptionBeforeExpiry: check('audio_file_pairing_tokens_consumption_before_expiry', sql`${table.consumedAt} is null or ${table.consumedAt} <= ${table.expiresAt}`),
  claimComplete: check('audio_file_pairing_tokens_claim_complete', sql`(${table.consumedAt} is null and ${table.consumedByUserId} is null and ${table.connectionId} is null and ${table.connectionMemberOneUserId} is null and ${table.connectionMemberTwoUserId} is null) or (${table.consumedAt} is not null and ${table.consumedByUserId} is not null and ${table.connectionId} is not null and ${table.connectionMemberOneUserId} is not null and ${table.connectionMemberTwoUserId} is not null)`),
  creatorCannotClaim: check('audio_file_pairing_tokens_creator_cannot_claim', sql`${table.consumedByUserId} is null or ${table.consumedByUserId} <> ${table.createdByUserId}`),
  connectionMembersMatchClaim: check('audio_file_pairing_tokens_connection_members_match_claim', sql`${table.connectionId} is null or ((${table.createdByUserId} = ${table.connectionMemberOneUserId} and ${table.consumedByUserId} = ${table.connectionMemberTwoUserId}) or (${table.createdByUserId} = ${table.connectionMemberTwoUserId} and ${table.consumedByUserId} = ${table.connectionMemberOneUserId}))`),
  consumedOrRevoked: check('audio_file_pairing_tokens_consumed_or_revoked', sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`),
  revocationComplete: check('audio_file_pairing_tokens_revocation_complete', sql`(${table.revokedAt} is null and ${table.revokedByUserId} is null) or (${table.revokedAt} is not null and ${table.revokedByUserId} is not null)`),
  connectionMembersFk: foreignKey({
    columns: [table.connectionId, table.connectionMemberOneUserId, table.connectionMemberTwoUserId],
    foreignColumns: [audioFileConnections.id, audioFileConnections.memberOneUserId, audioFileConnections.memberTwoUserId],
    name: 'audio_file_pairing_tokens_connection_members_fk'
  })
}));

// Connected people receive explicit access to selected immutable versions. The
// grant references the existing object identity; it never copies or moves bytes.
export const audioFileAccessGrants = pgTable('audio_file_access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => audioFileConnections.id),
  connectionMemberOneUserId: uuid('connection_member_one_user_id').notNull(),
  connectionMemberTwoUserId: uuid('connection_member_two_user_id').notNull(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id),
  assetVersionId: uuid('asset_version_id').notNull().references(() => audioProjectAssetVersions.id),
  grantorProjectAccessGrantId: uuid('grantor_project_access_grant_id').notNull().references(() => audioProjectAccessGrants.id),
  grantorCanManageAccess: boolean('grantor_can_manage_access').notNull().default(true),
  grantedByUserId: uuid('granted_by_user_id').notNull().references(() => users.id),
  granteeUserId: uuid('grantee_user_id').notNull().references(() => users.id),
  canStreamPreview: boolean('can_stream_preview').notNull().default(true),
  canDownloadOriginal: boolean('can_download_original').notNull().default(false),
  canUploadNewVersion: boolean('can_upload_new_version').notNull().default(false),
  canComment: boolean('can_comment').notNull().default(true),
  canApprove: boolean('can_approve').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
  revocationReason: text('revocation_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  activeConnectionAssetGranteeIdx: uniqueIndex('audio_file_access_grants_active_connection_asset_grantee_idx')
    .on(table.connectionId, table.assetVersionId, table.granteeUserId)
    .where(sql`${table.revokedAt} is null`),
  granteeExpiryIdx: index('audio_file_access_grants_grantee_expiry_idx').on(table.granteeUserId, table.expiresAt),
  differentUsers: check('audio_file_access_grants_different_users', sql`${table.grantedByUserId} <> ${table.granteeUserId}`),
  permissionRequired: check('audio_file_access_grants_permission_required', sql`${table.canStreamPreview} = true or ${table.canDownloadOriginal} = true or ${table.canUploadNewVersion} = true or ${table.canComment} = true or ${table.canApprove} = true`),
  expiryValid: check('audio_file_access_grants_expiry_valid', sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`),
  connectionMembersMatchGrant: check('audio_file_access_grants_connection_members_match_grant', sql`(${table.grantedByUserId} = ${table.connectionMemberOneUserId} and ${table.granteeUserId} = ${table.connectionMemberTwoUserId}) or (${table.grantedByUserId} = ${table.connectionMemberTwoUserId} and ${table.granteeUserId} = ${table.connectionMemberOneUserId})`),
  grantorManageAccessRequired: check('audio_file_access_grants_grantor_manage_access_required', sql`${table.grantorCanManageAccess} = true`),
  revokerMustBeParticipant: check('audio_file_access_grants_revoker_must_be_participant', sql`${table.revokedByUserId} is null or ${table.revokedByUserId} = ${table.grantedByUserId} or ${table.revokedByUserId} = ${table.granteeUserId}`),
  revocationComplete: check('audio_file_access_grants_revocation_complete', sql`(${table.revokedAt} is null and ${table.revokedByUserId} is null) or (${table.revokedAt} is not null and ${table.revokedByUserId} is not null)`),
  connectionMembersFk: foreignKey({
    columns: [table.connectionId, table.connectionMemberOneUserId, table.connectionMemberTwoUserId],
    foreignColumns: [audioFileConnections.id, audioFileConnections.memberOneUserId, audioFileConnections.memberTwoUserId],
    name: 'audio_file_access_grants_connection_members_fk'
  }),
  assetProjectFk: foreignKey({
    columns: [table.assetVersionId, table.projectId],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.projectId],
    name: 'audio_file_access_grants_asset_project_fk'
  }),
  grantorProjectAccessFk: foreignKey({
    columns: [table.grantorProjectAccessGrantId, table.projectId, table.grantedByUserId, table.grantorCanManageAccess],
    foreignColumns: [audioProjectAccessGrants.id, audioProjectAccessGrants.projectId, audioProjectAccessGrants.granteeUserId, audioProjectAccessGrants.canManageAccess],
    name: 'audio_file_access_grants_grantor_project_access_fk'
  })
}));

export const audioFileConnectionEvents = pgTable('audio_file_connection_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => audioFileConnections.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  pairingTokenId: uuid('pairing_token_id').references(() => audioFilePairingTokens.id),
  projectId: uuid('project_id').references(() => audioProjects.id),
  assetVersionId: uuid('asset_version_id').references(() => audioProjectAssetVersions.id),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  connectionCreatedIdx: index('audio_file_connection_events_connection_created_idx').on(table.connectionId, table.createdAt),
  eventTypeAllowed: check('audio_file_connection_events_event_type_allowed', sql`${table.eventType} in ('connected', 'file_requested', 'file_shared', 'connection_removed')`)
}));

export const audioShareGrants = pgTable('audio_share_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id, { onDelete: 'cascade' }),
  assetVersionId: uuid('asset_version_id').references(() => audioProjectAssetVersions.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  recipientEmailHash: text('recipient_email_hash'),
  recipientLabel: text('recipient_label'),
  permissions: jsonb('permissions').$type<{
    view: boolean;
    downloadOriginal: boolean;
    uploadVersion: boolean;
    approve: boolean;
  }>().notNull(),
  maxUses: integer('max_uses'),
  useCount: integer('use_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashIdx: uniqueIndex('audio_share_grants_token_hash_idx').on(table.tokenHash),
  projectExpiryIdx: index('audio_share_grants_project_expiry_idx').on(table.projectId, table.expiresAt),
  useCountValid: check('audio_share_grants_use_count_valid', sql`${table.useCount} >= 0`),
  maxUsesValid: check('audio_share_grants_max_uses_valid', sql`${table.maxUses} is null or ${table.maxUses} > 0`),
  withinMaxUses: check('audio_share_grants_within_max_uses', sql`${table.maxUses} is null or ${table.useCount} <= ${table.maxUses}`),
  assetProjectFk: foreignKey({
    columns: [table.assetVersionId, table.projectId],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.projectId],
    name: 'audio_share_grants_asset_project_fk'
  })
}));

export const audioReviewEvents = pgTable('audio_review_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetVersionId: uuid('asset_version_id').notNull().references(() => audioProjectAssetVersions.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  timecodeMs: integer('timecode_ms'),
  body: text('body'),
  supersedesEventId: uuid('supersedes_event_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  assetCreatedIdx: index('audio_review_events_asset_created_idx').on(table.assetVersionId, table.createdAt),
  eventTypeAllowed: check('audio_review_events_event_type_allowed', sql`${table.eventType} in ('comment', 'approved', 'changes_requested', 'approval_withdrawn', 'resolved')`),
  timecodeValid: check('audio_review_events_timecode_valid', sql`${table.timecodeMs} is null or ${table.timecodeMs} >= 0`)
}));

export const musicRecordings = pgTable('music_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  projectId: uuid('project_id').references(() => audioProjects.id, { onDelete: 'set null' }),
  masterAssetVersionId: uuid('master_asset_version_id').references(() => audioProjectAssetVersions.id),
  title: text('title').notNull(),
  versionTitle: text('version_title'),
  primaryArtistName: text('primary_artist_name').notNull(),
  isrc: text('isrc'),
  durationMs: integer('duration_ms'),
  isExplicit: boolean('is_explicit').notNull().default(false),
  languageCode: text('language_code'),
  originalReleaseDate: date('original_release_date'),
  rightsStatus: text('rights_status').notNull().default('draft'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  isrcIdx: uniqueIndex('music_recordings_isrc_idx').on(table.isrc).where(sql`${table.isrc} is not null`),
  idProjectIdx: uniqueIndex('music_recordings_id_project_idx').on(table.id, table.projectId),
  performerUpdatedIdx: index('music_recordings_performer_updated_idx').on(table.performerId, table.updatedAt),
  isrcValid: check('music_recordings_isrc_valid', sql`${table.isrc} is null or ${table.isrc} ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'`),
  durationValid: check('music_recordings_duration_valid', sql`${table.durationMs} is null or ${table.durationMs} > 0`),
  rightsStatusAllowed: check('music_recordings_rights_status_allowed', sql`${table.rightsStatus} in ('draft', 'declared', 'under_review', 'cleared', 'blocked')`),
  projectPerformerFk: foreignKey({
    columns: [table.projectId, table.performerId],
    foreignColumns: [audioProjects.id, audioProjects.performerId],
    name: 'music_recordings_project_performer_fk'
  }),
  masterPerformerFk: foreignKey({
    columns: [table.masterAssetVersionId, table.performerId],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.performerId],
    name: 'music_recordings_master_performer_fk'
  })
}));

export const musicRecordingCredits = pgTable('music_recording_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordingId: uuid('recording_id').notNull().references(() => musicRecordings.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  displayName: text('display_name').notNull(),
  role: text('role').notNull(),
  sequence: integer('sequence').notNull().default(0),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  recordingSequenceIdx: index('music_recording_credits_recording_sequence_idx').on(table.recordingId, table.sequence)
}));

export const musicReleases = pgTable('music_releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  projectId: uuid('project_id').references(() => audioProjects.id, { onDelete: 'set null' }),
  artworkAssetVersionId: uuid('artwork_asset_version_id').references(() => audioProjectAssetVersions.id),
  title: text('title').notNull(),
  primaryArtistName: text('primary_artist_name').notNull(),
  releaseType: text('release_type').notNull(),
  distributionMode: musicDistributionModeEnum('distribution_mode').notNull().default('private'),
  status: musicReleaseStatusEnum('status').notNull().default('draft'),
  upc: text('upc'),
  labelName: text('label_name'),
  pLine: text('p_line'),
  cLine: text('c_line'),
  originalReleaseDate: date('original_release_date'),
  scheduledReleaseAt: timestamp('scheduled_release_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  territories: jsonb('territories').$type<string[]>(),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  upcIdx: uniqueIndex('music_releases_upc_idx').on(table.upc).where(sql`${table.upc} is not null`),
  idProjectIdx: uniqueIndex('music_releases_id_project_idx').on(table.id, table.projectId),
  performerStatusIdx: index('music_releases_performer_status_idx').on(table.performerId, table.status),
  releaseTypeAllowed: check('music_releases_release_type_allowed', sql`${table.releaseType} in ('single', 'ep', 'album', 'comedy_special', 'spoken_word', 'other')`),
  upcValid: check('music_releases_upc_valid', sql`${table.upc} is null or ${table.upc} ~ '^[0-9]{8,14}$'`),
  projectPerformerFk: foreignKey({
    columns: [table.projectId, table.performerId],
    foreignColumns: [audioProjects.id, audioProjects.performerId],
    name: 'music_releases_project_performer_fk'
  }),
  artworkPerformerFk: foreignKey({
    columns: [table.artworkAssetVersionId, table.performerId],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.performerId],
    name: 'music_releases_artwork_performer_fk'
  })
}));

export const musicReleaseRecordings = pgTable('music_release_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => musicReleases.id, { onDelete: 'cascade' }),
  recordingId: uuid('recording_id').notNull().references(() => musicRecordings.id),
  discNumber: integer('disc_number').notNull().default(1),
  trackNumber: integer('track_number').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  releaseRecordingIdx: uniqueIndex('music_release_recordings_release_recording_idx').on(table.releaseId, table.recordingId),
  releasePositionIdx: uniqueIndex('music_release_recordings_release_position_idx').on(table.releaseId, table.discNumber, table.trackNumber),
  positionValid: check('music_release_recordings_position_valid', sql`${table.discNumber} > 0 and ${table.trackNumber} > 0`)
}));

export const musicRightsDeclarations = pgTable('music_rights_declarations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id),
  releaseId: uuid('release_id').notNull().references(() => musicReleases.id),
  recordingId: uuid('recording_id').references(() => musicRecordings.id),
  declaredByUserId: uuid('declared_by_user_id').notNull().references(() => users.id),
  declarationType: text('declaration_type').notNull(),
  termsDocumentAssetVersionId: uuid('terms_document_asset_version_id').notNull().references(() => audioProjectAssetVersions.id),
  termsVersion: text('terms_version').notNull(),
  termsHash: text('terms_hash').notNull(),
  declarationText: text('declaration_text').notNull(),
  declarationSha256: text('declaration_sha256').notNull(),
  evidence: jsonb('evidence').notNull(),
  declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  idDeclarationShaIdx: uniqueIndex('music_rights_declarations_id_declaration_sha_idx').on(table.id, table.declarationSha256),
  releaseTypeIdx: index('music_rights_declarations_release_type_idx').on(table.releaseId, table.declarationType),
  typeAllowed: check('music_rights_declarations_type_allowed', sql`${table.declarationType} in ('master_control', 'composition_control', 'sample_clearance', 'cover_license', 'beat_license', 'artwork_control', 'performer_consent', 'ai_disclosure', 'distribution_authorization')`),
  termsHashValid: check('music_rights_declarations_terms_hash_valid', sql`${table.termsHash} ~ '^[0-9a-f]{64}$'`),
  declarationShaValid: check('music_rights_declarations_declaration_sha_valid', sql`${table.declarationSha256} ~ '^[0-9a-f]{64}$'`),
  evidenceRequired: check('music_rights_declarations_evidence_required', sql`jsonb_typeof(${table.evidence}) = 'object' and ${table.evidence} <> '{}'::jsonb`),
  termsDocumentProjectHashFk: foreignKey({
    columns: [table.termsDocumentAssetVersionId, table.projectId, table.termsHash],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.projectId, audioProjectAssetVersions.sha256],
    name: 'music_rights_declarations_terms_document_project_hash_fk'
  }),
  releaseProjectFk: foreignKey({
    columns: [table.releaseId, table.projectId],
    foreignColumns: [musicReleases.id, musicReleases.projectId],
    name: 'music_rights_declarations_release_project_fk'
  }),
  recordingProjectFk: foreignKey({
    columns: [table.recordingId, table.projectId],
    foreignColumns: [musicRecordings.id, musicRecordings.projectId],
    name: 'music_rights_declarations_recording_project_fk'
  }),
  recordingReleaseFk: foreignKey({
    columns: [table.releaseId, table.recordingId],
    foreignColumns: [musicReleaseRecordings.releaseId, musicReleaseRecordings.recordingId],
    name: 'music_rights_declarations_recording_release_fk'
  })
}));

export const musicRightsDeclarationEvents = pgTable('music_rights_declaration_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  declarationId: uuid('declaration_id').notNull().references(() => musicRightsDeclarations.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  declarationSha256: text('declaration_sha256').notNull(),
  evidence: jsonb('evidence').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  declarationCreatedIdx: index('music_rights_declaration_events_declaration_created_idx').on(table.declarationId, table.createdAt),
  singleDeclaredIdx: uniqueIndex('music_rights_declaration_events_single_declared_idx').on(table.declarationId).where(sql`${table.eventType} = 'declared'`),
  singleReviewOutcomeIdx: uniqueIndex('music_rights_declaration_events_single_review_outcome_idx').on(table.declarationId).where(sql`${table.eventType} in ('verified', 'rejected')`),
  singleRevokedIdx: uniqueIndex('music_rights_declaration_events_single_revoked_idx').on(table.declarationId).where(sql`${table.eventType} = 'revoked'`),
  typeAllowed: check('music_rights_declaration_events_type_allowed', sql`${table.eventType} in ('declared', 'verified', 'rejected', 'revoked')`),
  declarationShaValid: check('music_rights_declaration_events_declaration_sha_valid', sql`${table.declarationSha256} ~ '^[0-9a-f]{64}$'`),
  evidenceRequired: check('music_rights_declaration_events_evidence_required', sql`jsonb_typeof(${table.evidence}) = 'object' and ${table.evidence} <> '{}'::jsonb`),
  declarationShaFk: foreignKey({
    columns: [table.declarationId, table.declarationSha256],
    foreignColumns: [musicRightsDeclarations.id, musicRightsDeclarations.declarationSha256],
    name: 'music_rights_declaration_events_declaration_sha_fk'
  })
}));

// Creator deals are immutable, creator-to-creator evidence. Sway is the
// distributor and never receives master or composition ownership through them.
// Amendments create a new deal version; acceptance/rejection is append-only.
export const audioCreatorDeals = pgTable('audio_creator_deals', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => audioProjects.id),
  releaseId: uuid('release_id').references(() => musicReleases.id),
  recordingId: uuid('recording_id').references(() => musicRecordings.id),
  proposedByUserId: uuid('proposed_by_user_id').notNull().references(() => users.id),
  dealType: text('deal_type').notNull(),
  title: text('title').notNull(),
  termsDocumentAssetVersionId: uuid('terms_document_asset_version_id').notNull().references(() => audioProjectAssetVersions.id),
  termsSha256: text('terms_sha256').notNull(),
  termsVersion: text('terms_version').notNull(),
  supersedesDealId: uuid('supersedes_deal_id').references((): AnyPgColumn => audioCreatorDeals.id),
  effectiveAt: timestamp('effective_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  projectCreatedIdx: index('audio_creator_deals_project_created_idx').on(table.projectId, table.createdAt),
  idTermsShaIdx: uniqueIndex('audio_creator_deals_id_terms_sha_idx').on(table.id, table.termsSha256),
  termsShaValid: check('audio_creator_deals_terms_sha_valid', sql`${table.termsSha256} ~ '^[0-9a-f]{64}$'`),
  typeAllowed: check('audio_creator_deals_type_allowed', sql`${table.dealType} in ('master_ownership', 'composition_ownership', 'producer_agreement', 'split_sheet', 'collaboration', 'license')`),
  termValid: check('audio_creator_deals_term_valid', sql`${table.expiresAt} is null or ${table.effectiveAt} is null or ${table.expiresAt} > ${table.effectiveAt}`),
  termsDocumentProjectFk: foreignKey({
    columns: [table.termsDocumentAssetVersionId, table.projectId, table.termsSha256],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.projectId, audioProjectAssetVersions.sha256],
    name: 'audio_creator_deals_terms_document_project_hash_fk'
  }),
  releaseProjectFk: foreignKey({
    columns: [table.releaseId, table.projectId],
    foreignColumns: [musicReleases.id, musicReleases.projectId],
    name: 'audio_creator_deals_release_project_fk'
  }),
  recordingProjectFk: foreignKey({
    columns: [table.recordingId, table.projectId],
    foreignColumns: [musicRecordings.id, musicRecordings.projectId],
    name: 'audio_creator_deals_recording_project_fk'
  })
}));

export const audioCreatorDealParties = pgTable('audio_creator_deal_parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull().references(() => audioCreatorDeals.id),
  userId: uuid('user_id').references(() => users.id),
  contactEmailHash: text('contact_email_hash'),
  displayName: text('display_name').notNull(),
  partyRole: text('party_role').notNull(),
  acceptanceRequired: boolean('acceptance_required').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  idDealIdx: uniqueIndex('audio_creator_deal_parties_id_deal_idx').on(table.id, table.dealId),
  dealRoleIdx: index('audio_creator_deal_parties_deal_role_idx').on(table.dealId, table.partyRole),
  accountRequired: check('audio_creator_deal_parties_account_required', sql`${table.userId} is not null`),
  emailHashValid: check('audio_creator_deal_parties_email_hash_valid', sql`${table.contactEmailHash} is null or ${table.contactEmailHash} ~ '^[0-9a-f]{64}$'`)
}));

export const audioCreatorDealAllocations = pgTable('audio_creator_deal_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull().references(() => audioCreatorDeals.id),
  partyId: uuid('party_id').notNull().references(() => audioCreatorDealParties.id),
  allocationType: text('allocation_type').notNull(),
  basisPoints: integer('basis_points'),
  fixedAmountCents: integer('fixed_amount_cents'),
  currency: text('currency').notNull().default('USD'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  dealTypeIdx: index('audio_creator_deal_allocations_deal_type_idx').on(table.dealId, table.allocationType),
  typeAllowed: check('audio_creator_deal_allocations_type_allowed', sql`${table.allocationType} in ('master_ownership', 'composition_ownership', 'sale_net_receipts', 'streaming_net_receipts', 'producer_points', 'recoupment', 'fixed_fee')`),
  valueRequired: check('audio_creator_deal_allocations_value_required', sql`${table.basisPoints} is not null or ${table.fixedAmountCents} is not null`),
  basisPointsValid: check('audio_creator_deal_allocations_basis_points_valid', sql`${table.basisPoints} is null or (${table.basisPoints} >= 0 and ${table.basisPoints} <= 10000)`),
  fixedAmountValid: check('audio_creator_deal_allocations_fixed_amount_valid', sql`${table.fixedAmountCents} is null or ${table.fixedAmountCents} >= 0`),
  partyDealFk: foreignKey({
    columns: [table.partyId, table.dealId],
    foreignColumns: [audioCreatorDealParties.id, audioCreatorDealParties.dealId],
    name: 'audio_creator_deal_allocations_party_deal_fk'
  })
}));

export const audioCreatorDealEvents = pgTable('audio_creator_deal_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull().references(() => audioCreatorDeals.id),
  partyId: uuid('party_id').references(() => audioCreatorDealParties.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  termsSha256: text('terms_sha256').notNull(),
  authenticationEvidence: jsonb('authentication_evidence'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  dealCreatedIdx: index('audio_creator_deal_events_deal_created_idx').on(table.dealId, table.createdAt),
  singleProposedIdx: uniqueIndex('audio_creator_deal_events_single_proposed_idx').on(table.dealId).where(sql`${table.eventType} = 'proposed'`),
  singlePartyResponseIdx: uniqueIndex('audio_creator_deal_events_single_party_response_idx').on(table.dealId, table.partyId).where(sql`${table.eventType} in ('accepted', 'rejected')`),
  eventTypeAllowed: check('audio_creator_deal_events_event_type_allowed', sql`${table.eventType} in ('proposed', 'invited', 'viewed', 'accepted', 'rejected', 'withdrawn', 'superseded')`),
  termsShaValid: check('audio_creator_deal_events_terms_sha_valid', sql`${table.termsSha256} ~ '^[0-9a-f]{64}$'`),
  partyRequired: check('audio_creator_deal_events_party_required', sql`${table.eventType} not in ('invited', 'viewed', 'accepted', 'rejected') or ${table.partyId} is not null`),
  authenticationEvidenceRequired: check('audio_creator_deal_events_authentication_evidence_required', sql`${table.eventType} not in ('accepted', 'rejected') or (jsonb_typeof(${table.authenticationEvidence}) = 'object' and ${table.authenticationEvidence} <> '{}'::jsonb)`),
  partyDealFk: foreignKey({
    columns: [table.partyId, table.dealId],
    foreignColumns: [audioCreatorDealParties.id, audioCreatorDealParties.dealId],
    name: 'audio_creator_deal_events_party_deal_fk'
  }),
  termsShaFk: foreignKey({
    columns: [table.dealId, table.termsSha256],
    foreignColumns: [audioCreatorDeals.id, audioCreatorDeals.termsSha256],
    name: 'audio_creator_deal_events_terms_sha_fk'
  })
}));

export const musicDistributionDeliveries = pgTable('music_distribution_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => musicReleases.id),
  providerKey: text('provider_key').notNull(),
  destinationKey: text('destination_key').notNull(),
  deliveryStatus: text('delivery_status').notNull().default('draft'),
  providerReleaseId: text('provider_release_id'),
  destinationReleaseId: text('destination_release_id'),
  metadataFingerprint: text('metadata_fingerprint'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  liveAt: timestamp('live_at', { withTimezone: true }),
  takedownRequestedAt: timestamp('takedown_requested_at', { withTimezone: true }),
  takenDownAt: timestamp('taken_down_at', { withTimezone: true }),
  lastError: text('last_error'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  releaseDestinationIdx: uniqueIndex('music_distribution_deliveries_release_destination_idx').on(table.releaseId, table.providerKey, table.destinationKey),
  statusUpdatedIdx: index('music_distribution_deliveries_status_updated_idx').on(table.deliveryStatus, table.updatedAt),
  statusAllowed: check('music_distribution_deliveries_status_allowed', sql`${table.deliveryStatus} in ('draft', 'queued', 'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down', 'failed')`),
  providerKeyRequired: check('music_distribution_deliveries_provider_key_required', sql`length(trim(${table.providerKey})) > 0`),
  destinationKeyRequired: check('music_distribution_deliveries_destination_key_required', sql`length(trim(${table.destinationKey})) > 0`),
  metadataFingerprintValid: check('music_distribution_deliveries_metadata_fingerprint_valid', sql`${table.metadataFingerprint} is null or ${table.metadataFingerprint} ~ '^[0-9a-f]{64}$'`)
}));

export const musicDistributionDeliveryEvents = pgTable('music_distribution_delivery_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').notNull().references(() => musicDistributionDeliveries.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  eventType: text('event_type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  providerEventId: text('provider_event_id'),
  previousStatus: text('previous_status'),
  nextStatus: text('next_status'),
  payloadSha256: text('payload_sha256'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  deliveryIdempotencyIdx: uniqueIndex('music_distribution_delivery_events_delivery_idempotency_idx').on(table.deliveryId, table.idempotencyKey),
  providerEventIdx: uniqueIndex('music_distribution_delivery_events_provider_event_idx').on(table.providerEventId).where(sql`${table.providerEventId} is not null`),
  deliveryCreatedIdx: index('music_distribution_delivery_events_delivery_created_idx').on(table.deliveryId, table.createdAt),
  eventTypeAllowed: check('music_distribution_delivery_events_event_type_allowed', sql`${table.eventType} in ('delivery_created', 'delivery_attempted', 'provider_webhook', 'status_changed', 'correction_requested')`),
  idempotencyRequired: check('music_distribution_delivery_events_idempotency_required', sql`length(trim(${table.idempotencyKey})) > 0`),
  payloadShaValid: check('music_distribution_delivery_events_payload_sha_valid', sql`${table.payloadSha256} is null or ${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  previousStatusAllowed: check('music_distribution_delivery_events_previous_status_allowed', sql`${table.previousStatus} is null or ${table.previousStatus} in ('draft', 'queued', 'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down', 'failed')`),
  nextStatusAllowed: check('music_distribution_delivery_events_next_status_allowed', sql`${table.nextStatus} is null or ${table.nextStatus} in ('draft', 'queued', 'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down', 'failed')`),
  statusShape: check('music_distribution_delivery_events_status_shape', sql`(${table.eventType} = 'delivery_created' and ${table.previousStatus} is null and ${table.nextStatus} = 'draft') or (${table.eventType} = 'status_changed' and ${table.previousStatus} is not null and ${table.nextStatus} is not null and ${table.previousStatus} <> ${table.nextStatus}) or (${table.eventType} not in ('delivery_created', 'status_changed') and ${table.previousStatus} is null and ${table.nextStatus} is null)`),
  providerShape: check('music_distribution_delivery_events_provider_shape', sql`(${table.eventType} = 'provider_webhook' and ${table.providerEventId} is not null and ${table.payloadSha256} is not null and ${table.actorUserId} is null) or (${table.eventType} <> 'provider_webhook' and ${table.providerEventId} is null)`)
}));

export const musicCatalogTransfers = pgTable('music_catalog_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceDistributor: text('source_distributor').notNull(),
  sourceAccountReference: text('source_account_reference'),
  sourceSnapshotAssetVersionId: uuid('source_snapshot_asset_version_id').references(() => audioProjectAssetVersions.id),
  status: catalogTransferStatusEnum('status').notNull().default('intake'),
  expectedReleaseCount: integer('expected_release_count'),
  expectedRecordingCount: integer('expected_recording_count'),
  knownLimitations: jsonb('known_limitations').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  continuityEvidenceFingerprint: text('continuity_evidence_fingerprint'),
  artistCutoverApprovedByUserId: uuid('artist_cutover_approved_by_user_id').references(() => users.id),
  artistCutoverApprovedAt: timestamp('artist_cutover_approved_at', { withTimezone: true }),
  artistCutoverApprovalFingerprint: text('artist_cutover_approval_fingerprint'),
  oldProviderTakedownRequestedAt: timestamp('old_provider_takedown_requested_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  performerStatusIdx: index('music_catalog_transfers_performer_status_idx').on(table.performerId, table.status),
  releaseCountValid: check('music_catalog_transfers_release_count_valid', sql`${table.expectedReleaseCount} is null or ${table.expectedReleaseCount} > 0`),
  recordingCountValid: check('music_catalog_transfers_recording_count_valid', sql`${table.expectedRecordingCount} is null or ${table.expectedRecordingCount} > 0`),
  knownLimitationsArray: check('music_catalog_transfers_known_limitations_array', sql`jsonb_typeof(${table.knownLimitations}) = 'array'`),
  continuityFingerprintValid: check('music_catalog_transfers_continuity_fingerprint_valid', sql`${table.continuityEvidenceFingerprint} is null or ${table.continuityEvidenceFingerprint} ~ '^[0-9a-f]{64}$'`),
  approvalComplete: check('music_catalog_transfers_approval_complete', sql`(${table.artistCutoverApprovedByUserId} is null and ${table.artistCutoverApprovedAt} is null and ${table.artistCutoverApprovalFingerprint} is null) or (${table.artistCutoverApprovedByUserId} is not null and ${table.artistCutoverApprovedAt} is not null and ${table.artistCutoverApprovalFingerprint} is not null)`),
  approvalFingerprintValid: check('music_catalog_transfers_approval_fingerprint_valid', sql`${table.artistCutoverApprovalFingerprint} is null or ${table.artistCutoverApprovalFingerprint} ~ '^[0-9a-f]{64}$'`),
  snapshotPerformerFk: foreignKey({
    columns: [table.sourceSnapshotAssetVersionId, table.performerId],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.performerId],
    name: 'music_catalog_transfers_snapshot_performer_fk'
  })
}));

export const musicCatalogTransferItems = pgTable('music_catalog_transfer_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferId: uuid('transfer_id').notNull().references(() => musicCatalogTransfers.id),
  releaseId: uuid('release_id').references(() => musicReleases.id),
  sourceReleaseId: text('source_release_id').notNull(),
  existingUpc: text('existing_upc'),
  sourceMetadataSnapshot: jsonb('source_metadata_snapshot').notNull(),
  artistIdentityMap: jsonb('artist_identity_map').notNull(),
  audioManifest: jsonb('audio_manifest').notNull(),
  artworkManifest: jsonb('artwork_manifest'),
  rightsEvidence: jsonb('rights_evidence'),
  commercialTerms: jsonb('commercial_terms'),
  baselinePublicState: jsonb('baseline_public_state'),
  storeContinuityReport: jsonb('store_continuity_report'),
  parityStatus: text('parity_status').notNull().default('pending'),
  storeMatchStatus: text('store_match_status').notNull().default('pending'),
  overlapVerifiedAt: timestamp('overlap_verified_at', { withTimezone: true }),
  knownLimitations: jsonb('known_limitations').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  ...timestamps
}, (table) => ({
  transferSourceReleaseIdx: uniqueIndex('music_catalog_transfer_items_transfer_source_release_idx').on(table.transferId, table.sourceReleaseId),
  transferParityIdx: index('music_catalog_transfer_items_transfer_parity_idx').on(table.transferId, table.parityStatus),
  upcValid: check('music_catalog_transfer_items_upc_valid', sql`${table.existingUpc} is null or ${table.existingUpc} ~ '^[0-9]{8,14}$'`),
  parityAllowed: check('music_catalog_transfer_items_parity_allowed', sql`${table.parityStatus} in ('pending', 'matched', 'mismatch', 'blocked')`),
  storeMatchAllowed: check('music_catalog_transfer_items_store_match_allowed', sql`${table.storeMatchStatus} in ('pending', 'matched', 'partial', 'failed', 'known_unavoidable_loss')`),
  knownLimitationsArray: check('music_catalog_transfer_items_known_limitations_array', sql`jsonb_typeof(${table.knownLimitations}) = 'array'`)
}));

export const musicCatalogTransferRecordings = pgTable('music_catalog_transfer_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferItemId: uuid('transfer_item_id').notNull().references(() => musicCatalogTransferItems.id),
  recordingId: uuid('recording_id').references(() => musicRecordings.id),
  sourceRecordingId: text('source_recording_id').notNull(),
  existingIsrc: text('existing_isrc'),
  sourceMasterSha256: text('source_master_sha256').notNull(),
  sourceAudioIdentity: jsonb('source_audio_identity').notNull(),
  sourceMetadataSnapshot: jsonb('source_metadata_snapshot').notNull(),
  sourceStoreIdentifiers: jsonb('source_store_identifiers').notNull(),
  baselinePublicState: jsonb('baseline_public_state'),
  continuityReport: jsonb('continuity_report'),
  parityStatus: text('parity_status').notNull().default('pending'),
  storeMatchStatus: text('store_match_status').notNull().default('pending'),
  overlapVerifiedAt: timestamp('overlap_verified_at', { withTimezone: true }),
  knownLimitations: jsonb('known_limitations').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  ...timestamps
}, (table) => ({
  transferItemSourceRecordingIdx: uniqueIndex('music_catalog_transfer_recordings_item_source_recording_idx').on(table.transferItemId, table.sourceRecordingId),
  transferItemParityIdx: index('music_catalog_transfer_recordings_item_parity_idx').on(table.transferItemId, table.parityStatus),
  isrcValid: check('music_catalog_transfer_recordings_isrc_valid', sql`${table.existingIsrc} is null or ${table.existingIsrc} ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'`),
  masterShaValid: check('music_catalog_transfer_recordings_master_sha_valid', sql`${table.sourceMasterSha256} ~ '^[0-9a-f]{64}$'`),
  parityAllowed: check('music_catalog_transfer_recordings_parity_allowed', sql`${table.parityStatus} in ('pending', 'matched', 'mismatch', 'blocked')`),
  storeMatchAllowed: check('music_catalog_transfer_recordings_store_match_allowed', sql`${table.storeMatchStatus} in ('pending', 'matched', 'partial', 'failed', 'known_unavoidable_loss')`),
  knownLimitationsArray: check('music_catalog_transfer_recordings_known_limitations_array', sql`jsonb_typeof(${table.knownLimitations}) = 'array'`)
}));

export const musicCatalogTransferEvents = pgTable('music_catalog_transfer_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferId: uuid('transfer_id').notNull().references(() => musicCatalogTransfers.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  previousStatus: catalogTransferStatusEnum('previous_status'),
  nextStatus: catalogTransferStatusEnum('next_status').notNull(),
  reason: text('reason').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  transferCreatedIdx: index('music_catalog_transfer_events_transfer_created_idx').on(table.transferId, table.createdAt)
}));

export const mediaConnectorLinks = pgTable('media_connector_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => audioProjects.id, { onDelete: 'cascade' }),
  assetVersionId: uuid('asset_version_id').references(() => audioProjectAssetVersions.id, { onDelete: 'cascade' }),
  providerKey: text('provider_key').notNull(),
  externalSourceId: text('external_source_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  connectionStatus: text('connection_status').notNull().default('linked'),
  capabilitySnapshot: jsonb('capability_snapshot').notNull(),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  providerSourceIdx: uniqueIndex('media_connector_links_provider_source_idx').on(table.providerKey, table.externalSourceId),
  projectStatusIdx: index('media_connector_links_project_status_idx').on(table.projectId, table.connectionStatus),
  resourceRequired: check('media_connector_links_resource_required', sql`${table.projectId} is not null or ${table.assetVersionId} is not null`),
  statusAllowed: check('media_connector_links_status_allowed', sql`${table.connectionStatus} in ('linked', 'syncing', 'ready', 'failed', 'revoked')`),
  assetProjectFk: foreignKey({
    columns: [table.assetVersionId, table.projectId],
    foreignColumns: [audioProjectAssetVersions.id, audioProjectAssetVersions.projectId],
    name: 'media_connector_links_asset_project_fk'
  })
}));
