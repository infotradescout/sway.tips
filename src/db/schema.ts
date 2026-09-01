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
  primaryKey,
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

export const performerVisibilityStateEnum = pgEnum('performer_visibility_state', [
  'draft',
  'unlisted',
  'public'
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
export const liveRoomPaymentOperationTypeEnum = pgEnum('live_room_payment_operation_type', [
  'authorize',
  'capture',
  'reverse'
]);
export const liveRoomPaymentOperationStatusEnum = pgEnum('live_room_payment_operation_status', [
  'pending',
  'leased',
  'awaiting_customer',
  'retryable_failed',
  'succeeded',
  'terminal_failed'
]);
export const liveRoomProcessorEventStatusEnum = pgEnum('live_room_processor_event_status', [
  'pending',
  'processing',
  'processed',
  'ignored',
  'retryable_failed',
  'terminal_failed'
]);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused', 'ended']);
export const attributionSourceEnum = pgEnum('attribution_source', ['creator_direct', 'sway_promoted']);
export const performerEventStatusEnum = pgEnum('performer_event_status', ['draft', 'published', 'cancelled']);
export const performerEventVisibilityEnum = pgEnum('performer_event_visibility', ['public', 'unlisted']);
export const performerEventTicketingModeEnum = pgEnum('performer_event_ticketing_mode', [
  'external',
  'native_ga'
]);
export const eventTicketOfferStatusEnum = pgEnum('event_ticket_offer_status', [
  'draft',
  'on_sale',
  'sales_closed',
  'cancelled'
]);
export const ticketSettlementPolicyEnum = pgEnum('ticket_settlement_policy', ['refund_only']);
export const ticketTaxModeEnum = pgEnum('ticket_tax_mode', ['stripe_automatic', 'not_required']);
export const ticketPaymentProcessorEnum = pgEnum('ticket_payment_processor', ['stripe']);
export const ticketChargeAccountEnum = pgEnum('ticket_charge_account', ['platform']);
export const ticketOrderStatusEnum = pgEnum('ticket_order_status', [
  'checkout_pending',
  'checkout_open',
  'payment_processing',
  'paid',
  'payment_failed',
  'expired',
  'refund_pending',
  'refunded',
  'disputed',
  'voided'
]);
export const eventTicketStatusEnum = pgEnum('event_ticket_status', [
  'held',
  'release_pending',
  'released',
  'refund_pending',
  'refunded',
  'disputed',
  'voided'
]);
export const ticketLedgerEntryTypeEnum = pgEnum('ticket_ledger_entry_type', [
  'charge_captured',
  'funds_held',
  'seller_transfer_succeeded',
  'buyer_refund_succeeded',
  'dispute_opened',
  'dispute_won',
  'dispute_lost',
  'charge_voided',
  'processor_adjustment',
  'processor_fee_recorded'
]);
export const ticketLedgerAccountEnum = pgEnum('ticket_ledger_account', [
  'platform_cash',
  'ticket_funds_held',
  'ticket_tax_payable',
  'performer_payable',
  'platform_fee_revenue',
  'processor_fee_expense',
  'buyer_refunds',
  'processor_disputes'
]);
export const ticketLedgerDirectionEnum = pgEnum('ticket_ledger_direction', ['debit', 'credit']);
export const ticketProcessorEventStatusEnum = pgEnum('ticket_processor_event_status', [
  'pending',
  'processing',
  'processed',
  'ignored',
  'retryable_failed',
  'terminal_failed'
]);
export const ticketPaymentOperationTypeEnum = pgEnum('ticket_payment_operation_type', [
  'create_checkout',
  'expire_checkout',
  'create_seller_transfer',
  'create_buyer_refund'
]);
export const ticketPaymentOperationStatusEnum = pgEnum('ticket_payment_operation_status', [
  'pending',
  'leased',
  'retryable_failed',
  'succeeded',
  'terminal_failed'
]);

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
  visibilityState: performerVisibilityStateEnum('visibility_state').notNull().default('draft'),
  onboardingStatus: performerOnboardingStatusEnum('onboarding_status').notNull().default('created'),
  paymentAccountStatus: paymentAccountStatusEnum('payment_account_status').notNull().default('not_started'),
  kycStatus: kycStatusEnum('kyc_status').notNull().default('not_required'),
  payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
  chargesEnabled: boolean('charges_enabled').notNull().default(false),
  stripeConnectedAccountId: text('stripe_connected_account_id'),
  stripeConnectStatusCheckedAt: timestamp('stripe_connect_status_checked_at', { withTimezone: true }),
  lifetimeGrossVolume: integer('lifetime_gross_volume').notNull().default(0),
  payoutHoldReason: text('payout_hold_reason'),
  verificationRequiredAtAmount: integer('verification_required_at_amount').notNull().default(10000),
  ...timestamps
}, (table) => ({
  handleIdx: uniqueIndex('idx_performers_handle').on(table.handle).where(sql`${table.handle} is not null`),
  handleLowerLookupIdx: index('idx_performers_handle_lower_lookup')
    .on(sql`lower(${table.handle})`)
    .where(sql`${table.handle} is not null`),
  stripeConnectedAccountUnique: uniqueIndex('performers_stripe_connected_account_id_unique')
    .on(table.stripeConnectedAccountId)
    .where(sql`${table.stripeConnectedAccountId} is not null`),
  handleNotReserved: check('performers_handle_not_reserved', sql`${table.handle} is null or lower(${table.handle}) not in ('admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover', 'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile', 'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway', 'talent', 'terms', 'www')`),
  ownerIdx: index('performers_owner_user_id_idx').on(table.ownerUserId)
}));

// One durable namespace owns every canonical, historical, and reserved public
// performer handle. Database triggers keep canonical claims synchronized with
// performer inserts and renames so old and new runtimes share the invariant.
export const performerHandleClaims = pgTable('performer_handle_claims', {
  normalizedHandle: text('normalized_handle').notNull(),
  performerId: uuid('performer_id').notNull().references(() => performers.id, { onDelete: 'cascade' }),
  claimKind: text('claim_kind').notNull(),
  legacyException: boolean('legacy_exception').notNull().default(false),
  ...timestamps
}, (table) => ({
  // Keep the legacy constraint name so old runtimes still classify conflicts
  // from the new authoritative namespace as ordinary handle-taken errors.
  normalizedHandlePk: primaryKey({
    name: 'idx_performers_handle_lower',
    columns: [table.normalizedHandle]
  }),
  performerIdx: index('performer_handle_claims_performer_idx').on(table.performerId),
  canonicalPerformerIdx: uniqueIndex('performer_handle_claims_canonical_performer_idx')
    .on(table.performerId)
    .where(sql`${table.claimKind} = 'canonical'`),
  lowercaseHandle: check(
    'performer_handle_claims_lowercase_handle',
    sql`${table.normalizedHandle} = lower(${table.normalizedHandle})`
  ),
  validHandle: check(
    'performer_handle_claims_valid_handle',
    sql`${table.normalizedHandle} ~ '^[a-z0-9_-]{4,30}$' or (${table.legacyException} = true and ${table.normalizedHandle} ~ '^[a-z0-9_-]{1,64}$' and ${table.claimKind} in ('canonical', 'redirect'))`
  ),
  claimKindAllowed: check(
    'performer_handle_claims_kind_allowed',
    sql`${table.claimKind} in ('canonical', 'redirect', 'reservation')`
  )
}));

// Durable outbox/lease for Stripe recipient provisioning. The provider call
// runs outside the reservation transaction, while the stable operation key is
// retained here and on the Stripe Account metadata so a post-provider crash
// can reconcile instead of creating another connected account.
export const stripeConnectOnboardingOperations = pgTable('stripe_connect_onboarding_operations', {
  performerId: uuid('performer_id').primaryKey().references(() => performers.id),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  operationKey: text('operation_key').notNull(),
  status: text('status').notNull().default('pending'),
  stripeAccountId: text('stripe_account_id'),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  ...timestamps
}, (table) => ({
  operationKeyIdx: uniqueIndex('stripe_connect_onboarding_operations_key_idx').on(table.operationKey),
  accountIdx: uniqueIndex('stripe_connect_onboarding_operations_account_idx')
    .on(table.stripeAccountId)
    .where(sql`${table.stripeAccountId} is not null`),
  statusAllowed: check(
    'stripe_connect_onboarding_operations_status_allowed',
    sql`${table.status} in ('pending', 'provisioning', 'bound')`
  ),
  attemptCountValid: check(
    'stripe_connect_onboarding_operations_attempt_count_valid',
    sql`${table.attemptCount} >= 0`
  ),
  leaseConsistent: check(
    'stripe_connect_onboarding_operations_lease_consistent',
    sql`(
      (${table.status} = 'provisioning' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)
      or
      (${table.status} <> 'provisioning' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)
    )`
  ),
  boundAccountRequired: check(
    'stripe_connect_onboarding_operations_bound_account_required',
    sql`${table.status} <> 'bound' or ${table.stripeAccountId} is not null`
  )
}));

// Runtime Stripe mode is part of the recipient identity. The original
// performers.* Connect columns and stripe_connect_onboarding_operations table
// remain as an immutable compatibility lane for historical test-mode data.
// New code reads and writes this mode-qualified binding instead, so changing
// Stripe credentials can never reinterpret a test account as a live account.
export const performerStripeConnectBindings = pgTable('performer_stripe_connect_bindings', {
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  paymentMode: text('payment_mode').notNull(),
  stripeAccountId: text('stripe_account_id').notNull(),
  paymentAccountStatus: paymentAccountStatusEnum('payment_account_status').notNull().default('not_started'),
  chargesEnabled: boolean('charges_enabled').notNull().default(false),
  payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
  statusCheckedAt: timestamp('status_checked_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.performerId, table.paymentMode] }),
  accountModeIdx: uniqueIndex('performer_stripe_connect_bindings_account_mode_idx')
    .on(table.paymentMode, table.stripeAccountId),
  performerIdx: index('performer_stripe_connect_bindings_performer_idx').on(table.performerId),
  paymentModeAllowed: check(
    'performer_stripe_connect_bindings_payment_mode_allowed',
    sql`${table.paymentMode} in ('test', 'live')`
  )
}));

// Mode-qualified successor to stripe_connect_onboarding_operations. The
// legacy table is deliberately retained so a rolling pre-migration process
// can finish a test operation without losing its historic operation key.
export const stripeConnectModeOnboardingOperations = pgTable('stripe_connect_mode_onboarding_operations', {
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  paymentMode: text('payment_mode').notNull(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  operationKey: text('operation_key').notNull(),
  status: text('status').notNull().default('pending'),
  stripeAccountId: text('stripe_account_id'),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.performerId, table.paymentMode] }),
  operationKeyIdx: uniqueIndex('stripe_connect_mode_onboarding_operations_key_idx').on(table.operationKey),
  accountModeIdx: uniqueIndex('stripe_connect_mode_onboarding_operations_account_mode_idx')
    .on(table.paymentMode, table.stripeAccountId)
    .where(sql`${table.stripeAccountId} is not null`),
  paymentModeAllowed: check(
    'stripe_connect_mode_onboarding_operations_payment_mode_allowed',
    sql`${table.paymentMode} in ('test', 'live')`
  ),
  statusAllowed: check(
    'stripe_connect_mode_onboarding_operations_status_allowed',
    sql`${table.status} in ('pending', 'provisioning', 'bound')`
  ),
  attemptCountValid: check(
    'stripe_connect_mode_onboarding_operations_attempt_count_valid',
    sql`${table.attemptCount} >= 0`
  ),
  leaseConsistent: check(
    'stripe_connect_mode_onboarding_operations_lease_consistent',
    sql`(
      (${table.status} = 'provisioning' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)
      or
      (${table.status} <> 'provisioning' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)
    )`
  ),
  boundAccountRequired: check(
    'stripe_connect_mode_onboarding_operations_bound_account_required',
    sql`${table.status} <> 'bound' or ${table.stripeAccountId} is not null`
  )
}));

// Stores only the performer's chosen payout rail. Full bank, debit-card,
// Cash App, and Venmo account details are collected and retained by the
// payment provider, never by Sway.
export const performerPayoutPreferences = pgTable('performer_payout_preferences', {
  performerId: uuid('performer_id').primaryKey().references(() => performers.id),
  destinationKind: text('destination_kind').notNull(),
  ...timestamps
}, (table) => ({
  destinationKindAllowed: check(
    'performer_payout_preferences_destination_kind_allowed',
    sql`${table.destinationKind} in ('bank_account', 'debit_card', 'cash_app_direct_deposit', 'venmo', 'paypal')`
  )
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

// A scheduled performer event exists independently from a live Sway room.
// Venue/location values are event context only; they never create a venue
// account, role, or authority boundary.
export const performerEvents = pgTable('performer_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id, { onDelete: 'cascade' }),
  clientRequestId: uuid('client_request_id').notNull(),
  createdByActorUserId: uuid('created_by_actor_user_id').notNull().references(() => users.id),
  lastMutationActorUserId: uuid('last_mutation_actor_user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  description: text('description'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  doorOpensAt: timestamp('door_opens_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  timeZone: text('time_zone').notNull(),
  locationName: text('location_name'),
  locationAddress: text('location_address'),
  city: text('city'),
  locationIsTba: boolean('location_is_tba').notNull().default(false),
  coverImageUrl: text('cover_image_url'),
  ticketingMode: performerEventTicketingModeEnum('ticketing_mode').notNull().default('external'),
  externalTicketUrl: text('external_ticket_url'),
  externalTicketLabel: text('external_ticket_label'),
  visibility: performerEventVisibilityEnum('visibility').notNull().default('unlisted'),
  status: performerEventStatusEnum('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancellationReason: text('cancellation_reason'),
  ...timestamps
}, (table) => ({
  performerClientRequestIdx: uniqueIndex('performer_events_performer_client_request_idx').on(
    table.performerId,
    table.clientRequestId
  ),
  idPerformerIdx: uniqueIndex('performer_events_id_performer_idx').on(table.id, table.performerId),
  performerStatusStartIdx: index('performer_events_performer_status_start_idx').on(
    table.performerId,
    table.status,
    table.startsAt
  ),
  publicStatusVisibilityStartIdx: index('performer_events_public_status_visibility_start_idx').on(
    table.status,
    table.visibility,
    table.startsAt
  ),
  endsAfterStarts: check(
    'performer_events_ends_after_starts',
    sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`
  ),
  nativeDoorRequired: check(
    'performer_events_native_door_required',
    sql`${table.ticketingMode} <> 'native_ga' OR ${table.doorOpensAt} IS NOT NULL`
  ),
  doorNotAfterStart: check(
    'performer_events_door_not_after_start',
    sql`${table.doorOpensAt} IS NULL OR ${table.doorOpensAt} <= ${table.startsAt}`
  ),
  publishedHasTimestamp: check(
    'performer_events_published_has_timestamp',
    sql`${table.status} <> 'published' OR ${table.publishedAt} IS NOT NULL`
  ),
  publishedHasExternalTicket: check(
    'performer_events_published_has_external_ticket',
    sql`${table.status} <> 'published' OR ${table.ticketingMode} = 'native_ga' OR ${table.externalTicketUrl} IS NOT NULL`
  ),
  cancelledHasTimestamp: check(
    'performer_events_cancelled_has_timestamp',
    sql`${table.status} <> 'cancelled' OR ${table.cancelledAt} IS NOT NULL`
  ),
  cancelledWasPublished: check(
    'performer_events_cancelled_was_published',
    sql`${table.status} <> 'cancelled' OR ${table.publishedAt} IS NOT NULL`
  ),
  cancelledHasReason: check(
    'performer_events_cancelled_has_reason',
    sql`${table.status} <> 'cancelled' OR (${table.cancellationReason} IS NOT NULL AND length(trim(${table.cancellationReason})) > 0)`
  ),
  coverImageUsesHttps: check(
    'performer_events_cover_image_uses_https',
    sql`${table.coverImageUrl} IS NULL OR ${table.coverImageUrl} ~* '^https://[^[:space:]]+$'`
  ),
  externalTicketUsesHttps: check(
    'performer_events_external_ticket_uses_https',
    sql`${table.externalTicketUrl} IS NULL OR ${table.externalTicketUrl} ~* '^https://[^[:space:]]+$'`
  ),
  externalTicketShape: check(
    'performer_events_external_ticket_shape',
    sql`(${table.externalTicketUrl} IS NULL AND ${table.externalTicketLabel} IS NULL) OR (${table.externalTicketUrl} IS NOT NULL AND ${table.externalTicketLabel} IS NOT NULL)`
  ),
  ticketingModeExclusive: check(
    'performer_events_ticketing_mode_exclusive',
    sql`${table.ticketingMode} = 'external' OR (${table.externalTicketUrl} IS NULL AND ${table.externalTicketLabel} IS NULL)`
  ),
  externalTicketLabelAllowed: check(
    'performer_events_external_ticket_label_allowed',
    sql`${table.externalTicketLabel} IS NULL OR ${table.externalTicketLabel} IN ('Get tickets', 'RSVP', 'View details')`
  )
}));

// Native paid GA tickets use a separate platform-charge/held-funds ledger.
// None of these rows cascade: financial and admission evidence must survive
// account, performer, event, and order cleanup attempts.
export const eventTicketOffers = pgTable('event_ticket_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull(),
  performerId: uuid('performer_id').notNull(),
  status: eventTicketOfferStatusEnum('status').notNull().default('draft'),
  capacity: integer('capacity').notNull(),
  faceValueCents: integer('face_value_cents').notNull(),
  mandatoryFeeBps: integer('mandatory_fee_bps').notNull(),
  mandatoryFeeFixedCents: integer('mandatory_fee_fixed_cents').notNull(),
  mandatoryFeeCents: integer('mandatory_fee_cents').notNull(),
  advertisedTotalCents: integer('advertised_total_cents').notNull(),
  sellerTransferAmountCents: integer('seller_transfer_amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  taxMode: ticketTaxModeEnum('tax_mode').notNull(),
  stripeTaxCode: text('stripe_tax_code'),
  settlementPolicy: ticketSettlementPolicyEnum('settlement_policy').notNull().default('refund_only'),
  checkoutReservationMinutes: integer('checkout_reservation_minutes').notNull(),
  refundGraceMinutes: integer('refund_grace_minutes').notNull(),
  salesOpenAt: timestamp('sales_open_at', { withTimezone: true }).notNull(),
  salesCloseAt: timestamp('sales_close_at', { withTimezone: true }).notNull(),
  sellerStripeAccountIdSnapshot: text('seller_stripe_account_id_snapshot').notNull(),
  sellerPaymentAccountStatusSnapshot: paymentAccountStatusEnum('seller_payment_account_status_snapshot').notNull(),
  sellerKycStatusSnapshot: kycStatusEnum('seller_kyc_status_snapshot').notNull(),
  sellerChargesEnabledSnapshot: boolean('seller_charges_enabled_snapshot').notNull(),
  sellerPayoutsEnabledSnapshot: boolean('seller_payouts_enabled_snapshot').notNull(),
  payoutReadinessCheckedAt: timestamp('payout_readiness_checked_at', { withTimezone: true }).notNull(),
  sellerTermsVersion: text('seller_terms_version').notNull(),
  sellerTermsHash: text('seller_terms_hash').notNull(),
  sellerTermsText: text('seller_terms_text').notNull(),
  sellerTermsSnapshot: jsonb('seller_terms_snapshot').notNull(),
  sellerTermsAcceptedByUserId: uuid('seller_terms_accepted_by_user_id').notNull().references(() => users.id),
  sellerTermsAcceptedAt: timestamp('seller_terms_accepted_at', { withTimezone: true }).notNull(),
  createdByActorUserId: uuid('created_by_actor_user_id').notNull().references(() => users.id),
  lastMutationActorUserId: uuid('last_mutation_actor_user_id').notNull().references(() => users.id),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  salesClosedAt: timestamp('sales_closed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  eventIdx: uniqueIndex('event_ticket_offers_event_idx').on(table.eventId),
  idEventPerformerIdx: uniqueIndex('event_ticket_offers_identity_idx').on(table.id, table.eventId, table.performerId),
  performerStatusIdx: index('event_ticket_offers_performer_status_idx').on(table.performerId, table.status),
  salesWindowIdx: index('event_ticket_offers_sales_window_idx').on(table.status, table.salesOpenAt, table.salesCloseAt),
  eventPerformerFk: foreignKey({
    columns: [table.eventId, table.performerId],
    foreignColumns: [performerEvents.id, performerEvents.performerId],
    name: 'event_ticket_offers_event_performer_fk'
  }),
  capacityValid: check('event_ticket_offers_capacity_valid', sql`${table.capacity} > 0 and ${table.capacity} <= 100000`),
  priceValid: check('event_ticket_offers_price_valid', sql`
    ${table.faceValueCents} >= 100
    and ${table.mandatoryFeeBps} between 0 and 5000
    and ${table.mandatoryFeeFixedCents} between 0 and 10000
    and ${table.mandatoryFeeCents} = (
      ((${table.faceValueCents}::bigint * ${table.mandatoryFeeBps}) + 9999) / 10000
    ) + ${table.mandatoryFeeFixedCents}
    and ${table.advertisedTotalCents} = ${table.faceValueCents} + ${table.mandatoryFeeCents}
    and ${table.advertisedTotalCents} <= 1000000
    and ${table.sellerTransferAmountCents} = ${table.faceValueCents}
  `),
  usdOnly: check('event_ticket_offers_usd_only', sql`${table.currency} = 'USD'`),
  taxModeCoherent: check('event_ticket_offers_tax_mode_coherent', sql`
    (${table.taxMode} = 'stripe_automatic' and ${table.stripeTaxCode} is not null and length(trim(${table.stripeTaxCode})) > 0)
    or (${table.taxMode} = 'not_required' and ${table.stripeTaxCode} is null)
  `),
  salesWindowValid: check('event_ticket_offers_sales_window_valid', sql`${table.salesCloseAt} > ${table.salesOpenAt}`),
  policyBounds: check('event_ticket_offers_policy_bounds', sql`
    ${table.checkoutReservationMinutes} between 31 and 60
    and ${table.refundGraceMinutes} between 60 and 10080
  `),
  payoutReady: check('event_ticket_offers_payout_ready', sql`
    ${table.sellerPaymentAccountStatusSnapshot} = 'payouts_enabled'
    and ${table.sellerKycStatusSnapshot} in ('not_required', 'verified')
    and ${table.sellerChargesEnabledSnapshot} = true
    and ${table.sellerPayoutsEnabledSnapshot} = true
    and length(trim(${table.sellerStripeAccountIdSnapshot})) > 0
  `),
  sellerTermsValid: check('event_ticket_offers_seller_terms_valid', sql`
    length(trim(${table.sellerTermsVersion})) > 0
    and ${table.sellerTermsHash} ~ '^[0-9a-f]{64}$'
    and length(trim(${table.sellerTermsText})) > 0
    and jsonb_typeof(${table.sellerTermsSnapshot}) = 'object'
    and ${table.sellerTermsSnapshot} <> '{}'::jsonb
  `),
  stateTimestamps: check('event_ticket_offers_state_timestamps', sql`
    (${table.status} <> 'on_sale' or ${table.activatedAt} is not null)
    and (${table.status} <> 'sales_closed' or ${table.salesClosedAt} is not null)
    and (${table.status} <> 'cancelled' or ${table.cancelledAt} is not null)
  `)
}));

export const ticketOrders = pgTable('ticket_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  offerId: uuid('offer_id').notNull(),
  eventId: uuid('event_id').notNull(),
  performerId: uuid('performer_id').notNull(),
  buyerUserId: uuid('buyer_user_id').notNull().references(() => users.id),
  clientRequestId: uuid('client_request_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  quantity: integer('quantity').notNull().default(1),
  faceValueCents: integer('face_value_cents').notNull(),
  mandatoryFeeCents: integer('mandatory_fee_cents').notNull(),
  advertisedTotalCents: integer('advertised_total_cents').notNull(),
  taxTotalCents: integer('tax_total_cents'),
  chargedTotalCents: integer('charged_total_cents'),
  sellerTransferAmountCents: integer('seller_transfer_amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  taxModeSnapshot: ticketTaxModeEnum('tax_mode_snapshot').notNull(),
  stripeTaxCodeSnapshot: text('stripe_tax_code_snapshot'),
  buyerTermsVersion: text('buyer_terms_version').notNull(),
  buyerTermsHash: text('buyer_terms_hash').notNull(),
  buyerTermsText: text('buyer_terms_text').notNull(),
  buyerTermsSnapshot: jsonb('buyer_terms_snapshot').notNull(),
  buyerTermsAcceptedAt: timestamp('buyer_terms_accepted_at', { withTimezone: true }).notNull(),
  status: ticketOrderStatusEnum('status').notNull().default('checkout_pending'),
  processor: ticketPaymentProcessorEnum('processor').notNull().default('stripe'),
  chargeAccount: ticketChargeAccountEnum('charge_account').notNull().default('platform'),
  captureMode: captureModeEnum('capture_mode').notNull().default('automatic'),
  processorCheckoutSessionId: text('processor_checkout_session_id'),
  processorPaymentIntentId: text('processor_payment_intent_id'),
  processorChargeId: text('processor_charge_id'),
  processorBalanceTransactionId: text('processor_balance_transaction_id'),
  processorFeeCents: integer('processor_fee_cents'),
  processorNetCents: integer('processor_net_cents'),
  checkoutExpiresAt: timestamp('checkout_expires_at', { withTimezone: true }),
  chargedAt: timestamp('charged_at', { withTimezone: true }),
  paymentFailedAt: timestamp('payment_failed_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  refundPendingAt: timestamp('refund_pending_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  disputedAt: timestamp('disputed_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  buyerRequestIdx: uniqueIndex('ticket_orders_buyer_request_idx').on(table.buyerUserId, table.clientRequestId),
  offerBuyerActiveIdx: uniqueIndex('ticket_orders_offer_buyer_active_idx')
    .on(table.offerId, table.buyerUserId)
    .where(sql`
      ${table.status} in ('checkout_pending', 'checkout_open', 'payment_processing', 'paid', 'disputed')
      and not (${table.status} = 'disputed' and ${table.refundedAt} is not null)
    `),
  identityIdx: uniqueIndex('ticket_orders_identity_idx').on(table.id, table.offerId, table.eventId, table.performerId),
  checkoutSessionIdx: uniqueIndex('ticket_orders_checkout_session_idx').on(table.processorCheckoutSessionId).where(sql`${table.processorCheckoutSessionId} is not null`),
  paymentIntentIdx: uniqueIndex('ticket_orders_payment_intent_idx').on(table.processorPaymentIntentId).where(sql`${table.processorPaymentIntentId} is not null`),
  chargeIdx: uniqueIndex('ticket_orders_charge_idx').on(table.processorChargeId).where(sql`${table.processorChargeId} is not null`),
  balanceTransactionIdx: uniqueIndex('ticket_orders_balance_transaction_idx')
    .on(table.processorBalanceTransactionId)
    .where(sql`${table.processorBalanceTransactionId} is not null`),
  offerStatusIdx: index('ticket_orders_offer_status_idx').on(table.offerId, table.status),
  buyerCreatedIdx: index('ticket_orders_buyer_created_idx').on(table.buyerUserId, table.createdAt),
  offerFk: foreignKey({
    columns: [table.offerId, table.eventId, table.performerId],
    foreignColumns: [eventTicketOffers.id, eventTicketOffers.eventId, eventTicketOffers.performerId],
    name: 'ticket_orders_offer_fk'
  }),
  oneTicketOnly: check('ticket_orders_one_ticket_only', sql`${table.quantity} = 1`),
  priceValid: check('ticket_orders_price_valid', sql`
    ${table.faceValueCents} >= 100
    and ${table.mandatoryFeeCents} >= 0
    and ${table.advertisedTotalCents} = ${table.faceValueCents} + ${table.mandatoryFeeCents}
    and ${table.sellerTransferAmountCents} = ${table.faceValueCents}
    and ${table.advertisedTotalCents} <= 1000000
  `),
  finalChargeCoherent: check('ticket_orders_final_charge_coherent', sql`
    (
      ${table.taxTotalCents} is null
      and ${table.chargedTotalCents} is null
      and ${table.processorBalanceTransactionId} is null
      and ${table.processorFeeCents} is null
      and ${table.processorNetCents} is null
    )
    or (
      ${table.taxTotalCents} is not null
      and ${table.taxTotalCents} >= 0
      and ${table.chargedTotalCents} = ${table.advertisedTotalCents} + ${table.taxTotalCents}
      and ${table.processorBalanceTransactionId} is not null
      and length(trim(${table.processorBalanceTransactionId})) > 0
      and ${table.processorFeeCents} is not null
      and ${table.processorFeeCents} >= 0
      and ${table.processorNetCents} is not null
      and ${table.processorNetCents} = ${table.chargedTotalCents} - ${table.processorFeeCents}
      and ${table.processorNetCents} > 0
    )
  `),
  usdOnly: check('ticket_orders_usd_only', sql`${table.currency} = 'USD'`),
  automaticPlatformCharge: check('ticket_orders_automatic_platform_charge', sql`${table.captureMode} = 'automatic'`),
  requestFingerprintValid: check('ticket_orders_request_fingerprint_valid', sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
  buyerTermsValid: check('ticket_orders_buyer_terms_valid', sql`
    length(trim(${table.buyerTermsVersion})) > 0
    and ${table.buyerTermsHash} ~ '^[0-9a-f]{64}$'
    and length(trim(${table.buyerTermsText})) > 0
    and jsonb_typeof(${table.buyerTermsSnapshot}) = 'object'
    and ${table.buyerTermsSnapshot} <> '{}'::jsonb
  `),
  chargedStateCoherent: check('ticket_orders_charged_state_coherent', sql`
    ${table.status} not in ('paid', 'refund_pending', 'refunded', 'disputed')
    or (
      ${table.chargedAt} is not null
      and ${table.processorPaymentIntentId} is not null
      and ${table.processorChargeId} is not null
      and ${table.taxTotalCents} is not null
      and ${table.chargedTotalCents} is not null
      and ${table.processorBalanceTransactionId} is not null
      and ${table.processorFeeCents} is not null
      and ${table.processorNetCents} is not null
    )
  `),
  stateTimestamps: check('ticket_orders_state_timestamps', sql`
    (${table.status} <> 'checkout_open' or (${table.processorCheckoutSessionId} is not null and ${table.checkoutExpiresAt} is not null))
    and (${table.status} <> 'payment_failed' or ${table.paymentFailedAt} is not null)
    and (${table.status} <> 'expired' or ${table.expiredAt} is not null)
    and (${table.status} <> 'refund_pending' or ${table.refundPendingAt} is not null)
    and (${table.status} <> 'refunded' or (${table.refundPendingAt} is not null and ${table.refundedAt} is not null))
    and (${table.status} <> 'disputed' or ${table.disputedAt} is not null)
    and (${table.status} <> 'voided' or ${table.voidedAt} is not null)
  `)
}));

export const eventTickets = pgTable('event_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  offerId: uuid('offer_id').notNull(),
  eventId: uuid('event_id').notNull(),
  performerId: uuid('performer_id').notNull(),
  buyerUserId: uuid('buyer_user_id').notNull().references(() => users.id),
  status: eventTicketStatusEnum('status').notNull().default('held'),
  admissionCredentialVersion: integer('admission_credential_version').notNull().default(1),
  admissionCredentialHash: text('admission_credential_hash').notNull(),
  admissionAcceptedAt: timestamp('admission_accepted_at', { withTimezone: true }),
  admissionAcceptedByUserId: uuid('admission_accepted_by_user_id').references(() => users.id),
  admissionIdempotencyKey: text('admission_idempotency_key'),
  admissionEvidenceHash: text('admission_evidence_hash'),
  releasePendingAt: timestamp('release_pending_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  refundPendingAt: timestamp('refund_pending_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  disputedAt: timestamp('disputed_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  orderIdx: uniqueIndex('event_tickets_order_idx').on(table.orderId),
  identityIdx: uniqueIndex('event_tickets_identity_idx').on(table.id, table.orderId, table.offerId, table.eventId, table.performerId),
  admissionKeyIdx: uniqueIndex('event_tickets_admission_key_idx').on(table.admissionIdempotencyKey).where(sql`${table.admissionIdempotencyKey} is not null`),
  eventStatusIdx: index('event_tickets_event_status_idx').on(table.eventId, table.status),
  buyerCreatedIdx: index('event_tickets_buyer_created_idx').on(table.buyerUserId, table.createdAt),
  orderFk: foreignKey({
    columns: [table.orderId, table.offerId, table.eventId, table.performerId],
    foreignColumns: [ticketOrders.id, ticketOrders.offerId, ticketOrders.eventId, ticketOrders.performerId],
    name: 'event_tickets_order_fk'
  }),
  credentialValid: check('event_tickets_credential_valid', sql`
    ${table.admissionCredentialVersion} > 0 and ${table.admissionCredentialHash} ~ '^[0-9a-f]{64}$'
  `),
  admissionEvidenceCoherent: check('event_tickets_admission_evidence_coherent', sql`
    (
      ${table.admissionAcceptedAt} is null
      and ${table.admissionAcceptedByUserId} is null
      and ${table.admissionIdempotencyKey} is null
      and ${table.admissionEvidenceHash} is null
    ) or (
      ${table.admissionAcceptedAt} is not null
      and ${table.admissionAcceptedByUserId} is not null
      and ${table.admissionIdempotencyKey} is not null
      and ${table.admissionEvidenceHash} ~ '^[0-9a-f]{64}$'
    )
  `),
  stateEvidence: check('event_tickets_state_evidence', sql`
    (${table.status} not in ('release_pending', 'released') or ${table.admissionAcceptedAt} is not null)
    and (${table.status} not in ('held', 'refund_pending', 'refunded', 'voided') or ${table.admissionAcceptedAt} is null)
  `),
  stateTimestamps: check('event_tickets_state_timestamps', sql`
    (${table.status} <> 'release_pending' or ${table.releasePendingAt} is not null)
    and (${table.status} <> 'released' or (${table.releasePendingAt} is not null and ${table.releasedAt} is not null))
    and (${table.status} <> 'refund_pending' or ${table.refundPendingAt} is not null)
    and (${table.status} <> 'refunded' or (${table.refundPendingAt} is not null and ${table.refundedAt} is not null))
    and (${table.status} <> 'disputed' or ${table.disputedAt} is not null)
    and (${table.status} <> 'voided' or ${table.voidedAt} is not null)
  `)
}));

export const ticketPaymentOperations = pgTable('ticket_payment_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => ticketOrders.id),
  ticketId: uuid('ticket_id').references(() => eventTickets.id),
  operationType: ticketPaymentOperationTypeEnum('operation_type').notNull(),
  status: ticketPaymentOperationStatusEnum('status').notNull().default('pending'),
  processor: ticketPaymentProcessorEnum('processor').notNull().default('stripe'),
  idempotencyKey: text('idempotency_key').notNull(),
  amountCents: integer('amount_cents'),
  currency: text('currency').notNull().default('USD'),
  requestPayload: jsonb('request_payload').notNull(),
  processorObjectId: text('processor_object_id'),
  resultPayload: jsonb('result_payload'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(12),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  idempotencyIdx: uniqueIndex('ticket_payment_operations_idempotency_idx').on(table.idempotencyKey),
  orderTypeIdx: uniqueIndex('ticket_payment_operations_order_type_idx').on(table.orderId, table.operationType),
  processorObjectIdx: uniqueIndex('ticket_payment_operations_processor_object_idx').on(table.processorObjectId).where(sql`${table.processorObjectId} is not null`),
  claimIdx: index('ticket_payment_operations_claim_idx').on(table.status, table.availableAt, table.leaseExpiresAt),
  ticketTypeIdx: index('ticket_payment_operations_ticket_type_idx').on(table.ticketId, table.operationType),
  usdOnly: check('ticket_payment_operations_usd_only', sql`${table.currency} = 'USD'`),
  requestPayloadValid: check('ticket_payment_operations_request_payload_valid', sql`jsonb_typeof(${table.requestPayload}) = 'object'`),
  attemptsValid: check('ticket_payment_operations_attempts_valid', sql`
    ${table.attemptCount} >= 0 and ${table.maxAttempts} > 0
  `),
  leaseCoherent: check('ticket_payment_operations_lease_coherent', sql`
    (${table.status} = 'leased' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)
    or (${table.status} <> 'leased' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)
  `),
  ticketRequired: check('ticket_payment_operations_ticket_required', sql`
    (${table.operationType} in ('create_checkout', 'expire_checkout') and ${table.ticketId} is null)
    or (${table.operationType} in ('create_seller_transfer', 'create_buyer_refund') and ${table.ticketId} is not null)
  `),
  amountValid: check('ticket_payment_operations_amount_valid', sql`
    (${table.operationType} = 'expire_checkout' and ${table.amountCents} is null)
    or (${table.operationType} <> 'expire_checkout' and ${table.amountCents} is not null and ${table.amountCents} > 0)
  `),
  completionCoherent: check('ticket_payment_operations_completion_coherent', sql`
    (${table.status} not in ('succeeded', 'terminal_failed') and ${table.completedAt} is null)
    or (${table.status} in ('succeeded', 'terminal_failed') and ${table.completedAt} is not null)
  `)
}));

// Append-only by contract; the migration must install UPDATE/DELETE guards.
export const ticketLedgerEntries = pgTable('ticket_ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => ticketOrders.id),
  ticketId: uuid('ticket_id').references(() => eventTickets.id),
  paymentOperationId: uuid('payment_operation_id').references(() => ticketPaymentOperations.id),
  entryType: ticketLedgerEntryTypeEnum('entry_type').notNull(),
  account: ticketLedgerAccountEnum('account').notNull(),
  direction: ticketLedgerDirectionEnum('direction').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  transactionKey: text('transaction_key').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  processorReference: text('processor_reference'),
  metadata: jsonb('metadata'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  idempotencyIdx: uniqueIndex('ticket_ledger_entries_idempotency_idx').on(table.idempotencyKey),
  transactionIdx: index('ticket_ledger_entries_transaction_idx').on(table.transactionKey),
  orderOccurredIdx: index('ticket_ledger_entries_order_occurred_idx').on(table.orderId, table.occurredAt),
  ticketOccurredIdx: index('ticket_ledger_entries_ticket_occurred_idx').on(table.ticketId, table.occurredAt),
  amountValid: check('ticket_ledger_entries_amount_valid', sql`${table.amountCents} > 0`),
  usdOnly: check('ticket_ledger_entries_usd_only', sql`${table.currency} = 'USD'`),
  keysValid: check('ticket_ledger_entries_keys_valid', sql`
    length(trim(${table.transactionKey})) > 0 and length(trim(${table.idempotencyKey})) > 0
  `)
}));

export const ticketProcessorEvents = pgTable('ticket_processor_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  processor: ticketPaymentProcessorEnum('processor').notNull().default('stripe'),
  processorEventId: text('processor_event_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  payload: jsonb('payload').notNull(),
  livemode: boolean('livemode').notNull(),
  orderId: uuid('order_id').references(() => ticketOrders.id),
  ticketId: uuid('ticket_id').references(() => eventTickets.id),
  paymentOperationId: uuid('payment_operation_id').references(() => ticketPaymentOperations.id),
  status: ticketProcessorEventStatusEnum('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  lastError: text('last_error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  processorEventIdx: uniqueIndex('ticket_processor_events_event_idx').on(table.processor, table.processorEventId),
  reconcileIdx: index('ticket_processor_events_reconcile_idx').on(table.status, table.nextAttemptAt),
  orderReceivedIdx: index('ticket_processor_events_order_received_idx').on(table.orderId, table.receivedAt),
  payloadHashValid: check('ticket_processor_events_payload_hash_valid', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  payloadValid: check('ticket_processor_events_payload_valid', sql`jsonb_typeof(${table.payload}) = 'object'`),
  attemptsValid: check('ticket_processor_events_attempts_valid', sql`${table.attemptCount} >= 0`),
  processedStateCoherent: check('ticket_processor_events_processed_state', sql`
    (${table.status} in ('processed', 'ignored') and ${table.processedAt} is not null)
    or (${table.status} not in ('processed', 'ignored') and ${table.processedAt} is null)
  `)
}));

// Only successful admissions are durable here. Rejected scans must not create
// an alternate admission state or consume the ticket.
export const ticketAdmissionEvents = pgTable('ticket_admission_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull(),
  orderId: uuid('order_id').notNull(),
  offerId: uuid('offer_id').notNull(),
  eventId: uuid('event_id').notNull(),
  performerId: uuid('performer_id').notNull(),
  acceptedByUserId: uuid('accepted_by_user_id').notNull().references(() => users.id),
  clientRequestId: uuid('client_request_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  admissionCredentialVersion: integer('admission_credential_version').notNull(),
  presentedCredentialHash: text('presented_credential_hash').notNull(),
  evidence: jsonb('evidence').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  ticketIdx: uniqueIndex('ticket_admission_events_ticket_idx').on(table.ticketId),
  idempotencyIdx: uniqueIndex('ticket_admission_events_idempotency_idx').on(table.idempotencyKey),
  actorRequestIdx: uniqueIndex('ticket_admission_events_actor_request_idx').on(table.acceptedByUserId, table.clientRequestId),
  eventAcceptedIdx: index('ticket_admission_events_event_accepted_idx').on(table.eventId, table.acceptedAt),
  ticketFk: foreignKey({
    columns: [table.ticketId, table.orderId, table.offerId, table.eventId, table.performerId],
    foreignColumns: [eventTickets.id, eventTickets.orderId, eventTickets.offerId, eventTickets.eventId, eventTickets.performerId],
    name: 'ticket_admission_events_ticket_fk'
  }),
  credentialValid: check('ticket_admission_events_credential_valid', sql`
    ${table.admissionCredentialVersion} > 0 and ${table.presentedCredentialHash} ~ '^[0-9a-f]{64}$'
  `),
  evidenceValid: check('ticket_admission_events_evidence_valid', sql`
    jsonb_typeof(${table.evidence}) = 'object' and ${table.evidence} <> '{}'::jsonb
  `),
  idempotencyValid: check('ticket_admission_events_idempotency_valid', sql`length(trim(${table.idempotencyKey})) > 0`)
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
  stateRevision: integer('state_revision').notNull().default(0),
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
  sessionType: text('session_type').notNull().default('browser'),
  gigId: uuid('gig_id').references(() => gigSessions.id),
  metadata: jsonb('metadata'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  issuedBy: uuid('issued_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenHashIdx: uniqueIndex('performer_sessions_token_hash_idx').on(table.tokenHash),
  actorExpiresIdx: index('performer_sessions_actor_expires_idx').on(table.actorUserId, table.expiresAt),
  actorTypeGigIdx: index('performer_sessions_actor_type_gig_idx').on(
    table.actorUserId,
    table.sessionType,
    table.gigId,
    table.expiresAt
  ),
  sessionTypeValid: check('performer_sessions_session_type_valid', sql`
    ${table.sessionType} in ('browser', 'control_bridge')
  `),
  bridgeGigScopeValid: check('performer_sessions_bridge_gig_scope_valid', sql`
    (${table.sessionType} = 'browser') or (${table.sessionType} = 'control_bridge' and ${table.gigId} is not null)
  `)
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

export const playbackCommands = pgTable('playback_commands', {
  id: uuid('id').primaryKey().defaultRandom(),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  clientCommandId: text('client_command_id').notNull(),
  sourceKey: text('source_key').notNull(),
  action: text('action').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('queued'),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  result: jsonb('result'),
  errorText: text('error_text'),
  ...timestamps
}, (table) => ({
  gigClientCommandIdx: uniqueIndex('playback_commands_gig_client_command_idx').on(
    table.gigId,
    table.clientCommandId
  ),
  claimQueueIdx: index('playback_commands_claim_queue_idx').on(
    table.gigId,
    table.sourceKey,
    table.status,
    table.createdAt
  ),
  statusValid: check('playback_commands_status_valid', sql`
    ${table.status} in ('queued', 'claimed', 'succeeded', 'failed', 'expired')
  `),
  actionValid: check('playback_commands_action_valid', sql`
    ${table.action} in ('load', 'play', 'pause', 'stop', 'cue', 'next', 'previous')
  `),
  sourceKeyValid: check('playback_commands_source_key_valid', sql`length(trim(${table.sourceKey})) > 0`),
  clientCommandIdValid: check('playback_commands_client_command_id_valid', sql`length(trim(${table.clientCommandId})) > 0`)
}));

export const playbackStates = pgTable('playback_states', {
  gigId: uuid('gig_id').primaryKey().references(() => gigSessions.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  sourceKey: text('source_key').notNull(),
  transport: text('transport').notNull(),
  bridgeInstanceId: text('bridge_instance_id').notNull(),
  connectionStatus: text('connection_status').notNull().default('connected'),
  deck: integer('deck'),
  trackTitle: text('track_title'),
  trackArtist: text('track_artist'),
  trackPath: text('track_path'),
  externalTrackId: text('external_track_id'),
  playing: boolean('playing'),
  positionMs: integer('position_ms'),
  durationMs: integer('duration_ms'),
  bpmTimes100: integer('bpm_times_100'),
  revision: integer('revision').notNull().default(0),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  performerObservedIdx: index('playback_states_performer_observed_idx').on(table.performerId, table.observedAt),
  connectionStatusValid: check('playback_states_connection_status_valid', sql`
    ${table.connectionStatus} in ('connected', 'degraded', 'disconnected')
  `),
  deckValid: check('playback_states_deck_valid', sql`${table.deck} is null or (${table.deck} >= 1 and ${table.deck} <= 8)`),
  positionValid: check('playback_states_position_valid', sql`${table.positionMs} is null or ${table.positionMs} >= 0`),
  durationValid: check('playback_states_duration_valid', sql`${table.durationMs} is null or ${table.durationMs} >= 0`)
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
  idempotencyKey: text('idempotency_key'),
  intentFingerprint: text('intent_fingerprint'),
  patronDeviceIdHash: text('patron_device_id_hash'),
  status: requestStatusEnum('status').notNull().default('submitted'),
  requestType: text('request_type').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  message: text('message'),
  runtimeRequestState: jsonb('runtime_request_state'),
  // Old-server writes omit this new column during the rolling deploy and must
  // remain visible. New payment reservations explicitly write NULL until the
  // processor reaches the action's required state.
  activatedAt: timestamp('activated_at', { withTimezone: true }).defaultNow(),
  stateRevision: integer('state_revision').notNull().default(0),
  ...timestamps
}, (table) => ({
  gigStatusIdx: index('requests_gig_status_idx').on(table.gigId, table.status),
  clientRequestIdx: uniqueIndex('requests_client_request_id_idx').on(table.clientRequestId),
  idempotencyIdx: uniqueIndex('requests_idempotency_key_idx').on(table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
  activeGigIdx: index('requests_active_gig_idx').on(table.gigId, table.activatedAt)
}));

export const requestBoosts = pgTable('request_boosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => requests.id),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  patronUserId: uuid('patron_user_id').references(() => users.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  // Kept nullable at the database boundary for one rolling deploy so the
  // pre-0028 server can continue inserting boosts while the migration runs.
  // Every new-server reservation supplies this identity explicitly.
  clientRequestId: text('client_request_id'),
  idempotencyKey: text('idempotency_key'),
  intentFingerprint: text('intent_fingerprint'),
  patronDeviceIdHash: text('patron_device_id_hash'),
  status: requestStatusEnum('status').notNull().default('submitted'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  runtimeBoostState: jsonb('runtime_boost_state'),
  // See requests.activatedAt: omission means a legacy visible row; an
  // explicit NULL means a new-server payment reservation is still invisible.
  activatedAt: timestamp('activated_at', { withTimezone: true }).defaultNow(),
  stateRevision: integer('state_revision').notNull().default(0),
  ...timestamps
}, (table) => ({
  requestIdx: index('request_boosts_request_id_idx').on(table.requestId),
  gigIdx: index('request_boosts_gig_id_idx').on(table.gigId),
  clientRequestIdx: uniqueIndex('request_boosts_client_request_id_idx').on(table.clientRequestId),
  idempotencyIdx: uniqueIndex('request_boosts_idempotency_key_idx').on(table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
  activeGigIdx: index('request_boosts_active_gig_idx').on(table.gigId, table.activatedAt)
}));

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  performerId: uuid('performer_id').references(() => performers.id),
  requestId: uuid('request_id').references(() => requests.id),
  requestBoostId: uuid('request_boost_id').references(() => requestBoosts.id),
  actionType: text('action_type'),
  idempotencyKey: text('idempotency_key'),
  destinationAccountId: text('destination_account_id'),
  // Provider environment snapshot. Existing/pre-migration rows are explicitly
  // test; live workers must never claim or reconcile them.
  paymentMode: text('payment_mode').notNull().default('test'),
  // Expand/contract rollout bridge. Migration 0028 defaults this true so the
  // still-running pre-0028 server remains write-compatible while Render applies
  // the migration. New code always writes false and must satisfy the binding
  // constraint; a later reconciled migration can retire the legacy lane.
  legacyUnlinked: boolean('legacy_unlinked').notNull().default(true),
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
  campaignIdx: index('payments_campaign_id_idx').on(table.campaignId),
  // Historical rows stay in the explicit legacy lane during the rolling
  // deploy. Enforce one payment per action only for new, fully bound writes so
  // an unknown pre-0028 duplicate cannot block the production migration.
  requestIdx: uniqueIndex('payments_request_id_idx').on(table.requestId).where(sql`${table.legacyUnlinked} = false and ${table.requestId} is not null`),
  requestBoostIdx: uniqueIndex('payments_request_boost_id_idx').on(table.requestBoostId).where(sql`${table.legacyUnlinked} = false and ${table.requestBoostId} is not null`),
  idempotencyIdx: uniqueIndex('payments_idempotency_key_idx').on(table.idempotencyKey).where(sql`${table.legacyUnlinked} = false and ${table.idempotencyKey} is not null`),
  durableActionLink: check('payments_durable_action_link', sql`
    ${table.legacyUnlinked}
    or (
      ${table.performerId} is not null
      and length(trim(${table.idempotencyKey})) > 0
      and length(trim(${table.destinationAccountId})) > 0
      and (
        (${table.actionType} in ('tip', 'request') and ${table.requestId} is not null and ${table.requestBoostId} is null)
        or (${table.actionType} = 'boost' and ${table.requestId} is null and ${table.requestBoostId} is not null)
      )
    )
  `),
  paymentModeAllowed: check('payments_payment_mode_allowed', sql`${table.paymentMode} in ('test', 'live')`)
}));

export const liveRoomPaymentOperations = pgTable('live_room_payment_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  gigId: uuid('gig_id').notNull().references(() => gigSessions.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  requestId: uuid('request_id').references(() => requests.id),
  requestBoostId: uuid('request_boost_id').references(() => requestBoosts.id),
  operationType: liveRoomPaymentOperationTypeEnum('operation_type').notNull(),
  status: liveRoomPaymentOperationStatusEnum('status').notNull().default('pending'),
  processor: text('processor').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  destinationAccountId: text('destination_account_id').notNull(),
  paymentMode: text('payment_mode').notNull().default('test'),
  requestPayload: jsonb('request_payload').notNull(),
  processorObjectId: text('processor_object_id'),
  resultPayload: jsonb('result_payload'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(20),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  idempotencyIdx: uniqueIndex('live_room_payment_operations_idempotency_idx').on(table.idempotencyKey),
  paymentTypeIdx: uniqueIndex('live_room_payment_operations_payment_type_idx').on(table.paymentId, table.operationType),
  processorObjectIdx: uniqueIndex('live_room_payment_operations_processor_object_idx').on(table.operationType, table.processorObjectId).where(sql`${table.processorObjectId} is not null`),
  claimIdx: index('live_room_payment_operations_claim_idx').on(table.status, table.availableAt, table.leaseExpiresAt),
  requestIdx: index('live_room_payment_operations_request_idx').on(table.requestId, table.operationType),
  requestBoostIdx: index('live_room_payment_operations_boost_idx').on(table.requestBoostId, table.operationType),
  requestPayloadValid: check('live_room_payment_operations_request_payload_valid', sql`jsonb_typeof(${table.requestPayload}) = 'object'`),
  actionLink: check('live_room_payment_operations_action_link', sql`
    ((${table.requestId} is not null)::int + (${table.requestBoostId} is not null)::int) = 1
    or (
      ${table.operationType} = 'reverse'
      and ${table.requestId} is null
      and ${table.requestBoostId} is null
    )
  `),
  attemptsValid: check('live_room_payment_operations_attempts_valid', sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0`),
  leaseCoherent: check('live_room_payment_operations_lease_coherent', sql`
    (${table.status} = 'leased' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)
    or (${table.status} <> 'leased' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)
  `),
  completionCoherent: check('live_room_payment_operations_completion_coherent', sql`
    (${table.status} in ('succeeded', 'terminal_failed') and ${table.completedAt} is not null)
    or (${table.status} not in ('succeeded', 'terminal_failed') and ${table.completedAt} is null)
  `),
  paymentModeAllowed: check(
    'live_room_payment_operations_payment_mode_allowed',
    sql`${table.paymentMode} in ('test', 'live')`
  )
}));

export const liveRoomProcessorEvents = pgTable('live_room_processor_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  processor: text('processor').notNull(),
  processorEventId: text('processor_event_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  payload: jsonb('payload').notNull(),
  livemode: boolean('livemode').notNull(),
  paymentId: uuid('payment_id').references(() => payments.id),
  paymentOperationId: uuid('payment_operation_id').references(() => liveRoomPaymentOperations.id),
  status: liveRoomProcessorEventStatusEnum('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  // A random claim generation fences a worker that resumes after its lease
  // was reclaimed and completed by another process.
  processingLeaseOwner: text('processing_lease_owner'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  lastError: text('last_error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  processorEventIdx: uniqueIndex('live_room_processor_events_event_idx').on(table.processor, table.processorEventId),
  reconcileIdx: index('live_room_processor_events_reconcile_idx').on(table.status, table.nextAttemptAt),
  paymentReceivedIdx: index('live_room_processor_events_payment_idx').on(table.paymentId, table.receivedAt),
  payloadHashValid: check('live_room_processor_events_payload_hash_valid', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  payloadValid: check('live_room_processor_events_payload_valid', sql`jsonb_typeof(${table.payload}) = 'object'`),
  attemptsValid: check('live_room_processor_events_attempts_valid', sql`${table.attemptCount} >= 0`),
  processedStateCoherent: check('live_room_processor_events_processed_state', sql`
    (${table.status} in ('processed', 'ignored') and ${table.processedAt} is not null)
    or (${table.status} not in ('processed', 'ignored') and ${table.processedAt} is null)
  `)
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

// One withdrawal debits the performer's accumulated captured earnings. The
// gross amount is removed from the Sway balance once; the provider fee and net
// delivery amount are immutable quote snapshots for reconciliation.
export const performerWithdrawals = pgTable('performer_withdrawals', {
  id: uuid('id').primaryKey().defaultRandom(),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  idempotencyKey: text('idempotency_key').notNull(),
  destinationKind: text('destination_kind').notNull(),
  deliverySpeed: text('delivery_speed').notNull(),
  status: text('status').notNull().default('requested'),
  grossAmountCents: integer('gross_amount_cents').notNull(),
  providerFeeCents: integer('provider_fee_cents').notNull(),
  netAmountCents: integer('net_amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  provider: text('provider'),
  providerPayoutId: text('provider_payout_id'),
  failureCode: text('failure_code'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  ...timestamps
}, (table) => ({
  performerCreatedIdx: index('performer_withdrawals_performer_created_idx').on(table.performerId, table.createdAt),
  performerIdempotencyIdx: uniqueIndex('performer_withdrawals_performer_idempotency_idx').on(table.performerId, table.idempotencyKey),
  providerPayoutIdx: uniqueIndex('performer_withdrawals_provider_payout_idx')
    .on(table.provider, table.providerPayoutId)
    .where(sql`${table.providerPayoutId} is not null`),
  destinationAllowed: check('performer_withdrawals_destination_allowed', sql`${table.destinationKind} in ('bank_account', 'debit_card', 'cash_app_direct_deposit', 'venmo', 'paypal')`),
  speedAllowed: check('performer_withdrawals_speed_allowed', sql`${table.deliverySpeed} in ('standard', 'instant')`),
  statusAllowed: check('performer_withdrawals_status_allowed', sql`${table.status} in ('requested', 'processing', 'paid', 'failed', 'canceled')`),
  positiveGross: check('performer_withdrawals_positive_gross', sql`${table.grossAmountCents} > 0`),
  nonnegativeFee: check('performer_withdrawals_nonnegative_fee', sql`${table.providerFeeCents} >= 0`),
  amountEquation: check('performer_withdrawals_amount_equation', sql`${table.netAmountCents} > 0 and ${table.netAmountCents} + ${table.providerFeeCents} = ${table.grossAmountCents}`),
  currencyUsd: check('performer_withdrawals_currency_usd', sql`${table.currency} = 'USD'`),
  paidShape: check('performer_withdrawals_paid_shape', sql`(${table.status} = 'paid' and ${table.paidAt} is not null and ${table.providerPayoutId} is not null) or (${table.status} <> 'paid' and ${table.paidAt} is null)`)
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
  activeLookupIdx: index('active_blocks_scope_value_idx').on(table.scope, table.normalizedValue),
  lifecycleShape: check('active_blocks_lifecycle_shape', sql`(${table.status} = 'active' and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null)`)
}));

export const moderationMutationKeys = pgTable('moderation_mutation_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyHash: text('key_hash').notNull(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  actionType: text('action_type').notNull(),
  intentFingerprint: text('intent_fingerprint').notNull(),
  firstResponseStatus: integer('first_response_status'),
  firstResponseBody: jsonb('first_response_body'),
  ...timestamps
}, (table) => ({
  keyHashIdx: uniqueIndex('moderation_mutation_keys_key_hash_idx').on(table.keyHash),
  actionTypeAllowed: check('moderation_mutation_keys_action_type_allowed', sql`${table.actionType} in ('block', 'block_revoke')`)
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
  ownerToken: text('owner_token'),
  ownerGeneration: integer('owner_generation').notNull().default(0),
  ownerLeaseExpiresAt: timestamp('owner_lease_expires_at', { withTimezone: true }),
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
  lyricsAuthorship: text('lyrics_authorship').notNull().default('not_declared'),
  compositionAuthorship: text('composition_authorship').notNull().default('not_declared'),
  vocalPerformance: text('vocal_performance').notNull().default('not_declared'),
  productionMethod: text('production_method').notNull().default('not_declared'),
  lyricsExcerpt: text('lyrics_excerpt'),
  rightsStatus: text('rights_status').notNull().default('draft'),
  metadata: jsonb('metadata'),
  ...timestamps
}, (table) => ({
  isrcIdx: uniqueIndex('music_recordings_isrc_idx').on(table.isrc).where(sql`${table.isrc} is not null`),
  idProjectIdx: uniqueIndex('music_recordings_id_project_idx').on(table.id, table.projectId),
  performerUpdatedIdx: index('music_recordings_performer_updated_idx').on(table.performerId, table.updatedAt),
  isrcValid: check('music_recordings_isrc_valid', sql`${table.isrc} is null or ${table.isrc} ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'`),
  durationValid: check('music_recordings_duration_valid', sql`${table.durationMs} is null or ${table.durationMs} > 0`),
  lyricsAuthorshipAllowed: check('music_recordings_lyrics_authorship_allowed', sql`${table.lyricsAuthorship} in ('not_declared', 'human', 'human_ai_assisted', 'generated', 'instrumental')`),
  compositionAuthorshipAllowed: check('music_recordings_composition_authorship_allowed', sql`${table.compositionAuthorship} in ('not_declared', 'human', 'human_ai_assisted', 'generated')`),
  vocalPerformanceAllowed: check('music_recordings_vocal_performance_allowed', sql`${table.vocalPerformance} in ('not_declared', 'human', 'virtual_original', 'licensed_replica', 'mixed', 'instrumental')`),
  productionMethodAllowed: check('music_recordings_production_method_allowed', sql`${table.productionMethod} in ('not_declared', 'human', 'ai_assisted', 'generated', 'mixed')`),
  lyricsExcerptValid: check('music_recordings_lyrics_excerpt_valid', sql`${table.lyricsExcerpt} is null or (char_length(trim(${table.lyricsExcerpt})) between 1 and 500)`),
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
  idPerformerIdx: uniqueIndex('music_releases_id_performer_idx').on(table.id, table.performerId),
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

export const musicReleaseReports = pgTable('music_release_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => musicReleases.id),
  reporterUserId: uuid('reporter_user_id').notNull().references(() => users.id),
  reason: text('reason').notNull(),
  details: text('details').notNull(),
  status: text('status').notNull().default('pending'),
  ...timestamps
}, (table) => ({
  releaseCreatedIdx: index('music_release_reports_release_created_idx').on(table.releaseId, table.createdAt),
  statusCreatedIdx: index('music_release_reports_status_created_idx').on(table.status, table.createdAt),
  activeIdentityIdx: uniqueIndex('music_release_reports_active_identity_idx')
    .on(table.releaseId, table.reporterUserId, table.reason)
    .where(sql`${table.status} in ('pending', 'escalated')`),
  reasonAllowed: check('music_release_reports_reason_allowed', sql`${table.reason} in ('copied_lyrics', 'unauthorized_voice', 'unlicensed_sample', 'missing_commercial_rights', 'incorrect_creation_credit', 'spam_or_duplicate', 'fake_engagement', 'impersonation')`),
  statusAllowed: check('music_release_reports_status_allowed', sql`${table.status} in ('pending', 'dismissed', 'escalated', 'resolved')`),
  detailsValid: check('music_release_reports_details_valid', sql`char_length(trim(${table.details})) between 40 and 2000`)
}));

export const musicReleaseReportEvents = pgTable('music_release_report_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => musicReleaseReports.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  note: text('note').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  reportCreatedIdx: index('music_release_report_events_report_created_idx').on(table.reportId, table.createdAt),
  singleSubmittedIdx: uniqueIndex('music_release_report_events_single_submitted_idx')
    .on(table.reportId)
    .where(sql`${table.eventType} = 'submitted'`),
  eventTypeAllowed: check('music_release_report_events_type_allowed', sql`${table.eventType} in ('submitted', 'dismissed', 'escalated', 'resolved')`),
  noteValid: check('music_release_report_events_note_valid', sql`char_length(trim(${table.note})) between 1 and 2000`)
}));

export const musicReleaseStorageManifests = pgTable('music_release_storage_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => musicReleases.id),
  performerId: uuid('performer_id').notNull().references(() => performers.id),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceType: text('source_type').notNull(),
  sourceEventId: uuid('source_event_id').notNull(),
  packageRevision: integer('package_revision').notNull(),
  packageFingerprint: text('package_fingerprint').notNull(),
  assets: jsonb('assets').$type<Array<{
    assetVersionId: string;
    sha256: string;
    byteSize: number;
    roles: string[];
  }>>().notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  releaseRevisionIdx: uniqueIndex('music_release_storage_manifests_release_revision_idx')
    .on(table.releaseId, table.packageRevision),
  releaseFingerprintIdx: uniqueIndex('music_release_storage_manifests_release_fingerprint_idx')
    .on(table.releaseId, table.packageFingerprint),
  sourceEventIdx: uniqueIndex('music_release_storage_manifests_source_event_idx')
    .on(table.sourceType, table.sourceEventId),
  performerCreatedIdx: index('music_release_storage_manifests_performer_created_idx')
    .on(table.performerId, table.createdAt),
  sourceTypeAllowed: check(
    'music_release_storage_manifests_source_type_allowed',
    sql`${table.sourceType} in ('readiness_pass', 'delivery_submission')`
  ),
  revisionValid: check(
    'music_release_storage_manifests_revision_valid',
    sql`${table.packageRevision} > 0`
  ),
  fingerprintValid: check(
    'music_release_storage_manifests_fingerprint_valid',
    sql`${table.packageFingerprint} ~ '^[0-9a-f]{64}$'`
  ),
  assetsRequired: check(
    'music_release_storage_manifests_assets_required',
    sql`jsonb_typeof(${table.assets}) = 'array' and jsonb_array_length(${table.assets}) > 0`
  ),
  releasePerformerFk: foreignKey({
    columns: [table.releaseId, table.performerId],
    foreignColumns: [musicReleases.id, musicReleases.performerId],
    name: 'music_release_storage_manifests_release_performer_fk'
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
