import type { Express, Request } from 'express';
import { sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import type { AccessControl } from './access-control';

type Executor = Pick<SwayDb, 'execute'>;
const CODE = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COOKIE = 'sway_affiliate_ref';
const ORIGIN = 'https://app.sway.tips';
export const AFFILIATE_POLICY_VERSION = '2026-09-08';

export function readAffiliateReferralCode(req: Pick<Request, 'headers'>): string | null {
  const raw = req.headers.cookie?.split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return raw && CODE.test(raw) ? raw : null;
}

// Called inside self-serve account creation, using the same transaction. The
// unique referred_user_id plus INSERT ... DO NOTHING makes first attribution
// durable under retries. Neither a client user ID nor a client rate is accepted.
export async function bindAffiliateReferral(db: Executor, userId: string, code: string | null) {
  if (!code || !CODE.test(code)) return;
  await db.execute(sql`
    INSERT INTO affiliate_referrals(referred_user_id, affiliate_account_id)
    SELECT ${userId}::uuid, a.id FROM affiliate_accounts a JOIN users u ON u.id = a.user_id
    WHERE a.code = ${code} AND a.user_id <> ${userId}::uuid AND u.email IS NOT NULL
    ON CONFLICT (referred_user_id) DO NOTHING
  `);
}

export async function bindAffiliateReferralForFirstClaim(db: Executor, userId: string, code: string | null) {
  if (!code || !CODE.test(code)) return;
  const original = await db.execute(sql`SELECT id FROM users WHERE id = ${userId}::uuid
    AND password_hash IS NULL AND email_verified_at IS NULL AND terms_accepted_at IS NULL FOR UPDATE`);
  if (original.rows.length) await bindAffiliateReferral(db, userId, code);
}

export async function loadSwayProgramMembership(db: Executor, userId: string) {
  const result = await db.execute(sql`
    SELECT coalesce(bool_or(m.is_friend), false) AS "isFriend",
      coalesce(bool_or(m.is_partner), false) AS "isPartner",
      coalesce(bool_or(m.is_exclusive), false) AS "isExclusive",
      sway_affiliate_rate_bps(${userId}::uuid) AS "rateBps"
    FROM sway_program_memberships m LEFT JOIN performers p ON p.id = m.performer_id
    WHERE m.user_id = ${userId}::uuid OR p.owner_user_id = ${userId}::uuid
  `);
  return result.rows[0] as { isFriend: boolean; isPartner: boolean; isExclusive: boolean; rateBps: number };
}

export async function loadSwayProgramMembershipForPerformer(db: Executor, performerId: string) {
  // A public badge reflects this artist or an explicit account grant. The
  // account's affiliate rate can aggregate its artists without transferring
  // one artist's recognition to another artist owned by the same account.
  const result = await db.execute(sql`
    SELECT coalesce(bool_or(m.is_friend), false) AS "isFriend",
      coalesce(bool_or(m.is_partner), false) AS "isPartner",
      coalesce(bool_or(m.is_exclusive), false) AS "isExclusive"
    FROM performers p LEFT JOIN sway_program_memberships m
      ON m.performer_id = p.id OR m.user_id = p.owner_user_id
    WHERE p.id = ${performerId}::uuid
  `);
  return result.rows[0] as { isFriend: boolean; isPartner: boolean; isExclusive: boolean };
}

export async function loadAffiliateOverview(db: Executor, userId: string) {
  // Repairs legacy identities idempotently; normal signup is enrolled by the
  // database trigger, including admin/invite/claim paths and every account role.
  await db.execute(sql`INSERT INTO affiliate_accounts(user_id) SELECT id FROM users WHERE id = ${userId}::uuid ON CONFLICT (user_id) DO NOTHING`);
  const identity = await db.execute(sql`SELECT id, code FROM affiliate_accounts WHERE user_id = ${userId}::uuid`);
  const account = identity.rows[0] as { id: string; code: string } | undefined;
  if (!account) throw new Error('affiliate_account_unavailable');
  const membership = await loadSwayProgramMembership(db, userId);
  const counts = await db.execute(sql`SELECT count(*)::integer AS total FROM affiliate_referrals WHERE affiliate_account_id = ${account.id}::uuid`);
  const earnings = await db.execute(sql`
    WITH by_payment AS (
      SELECT e.payment_id, e.payment_mode, e.currency, sum(e.amount_cents)::bigint AS net,
        sum(CASE WHEN e.event_kind = 'earned' THEN e.amount_cents ELSE 0 END)::bigint AS earned,
        -sum(CASE WHEN e.event_kind = 'reversed' THEN e.amount_cents ELSE 0 END)::bigint AS reversed
      FROM affiliate_commission_events e WHERE e.affiliate_account_id = ${account.id}::uuid
      GROUP BY e.payment_id, e.payment_mode, e.currency
    )
    SELECT b.payment_mode AS "paymentMode", b.currency,
      sum(b.earned)::text AS "earnedCents", sum(b.reversed)::text AS "reversedCents",
      sum(b.net)::text AS "netCents",
      sum(CASE WHEN p.id IS NULL OR p.payment_status = 'disputed' OR p.refund_status = 'pending'
        THEN b.net ELSE 0 END)::text AS "heldCents"
    FROM by_payment b LEFT JOIN payments p ON p.id = b.payment_id
    GROUP BY b.payment_mode, b.currency ORDER BY b.payment_mode, b.currency
  `);
  const profiles = await db.execute(sql`SELECT handle FROM performers WHERE owner_user_id = ${userId}::uuid
    AND is_active AND visibility_state = 'public' AND onboarding_status NOT IN ('restricted', 'suspended')
    AND nullif(trim(bio), '') IS NOT NULL ORDER BY created_at LIMIT 1`);
  const handle = profiles.rows[0]?.handle;
  const share = (path: string) => `${ORIGIN}${path}?ref=${account.code}`;
  return {
    enrolled: true,
    code: account.code,
    rateBps: membership.rateBps,
    tier: membership.isExclusive ? 'sway_exclusive' : membership.rateBps === 2000 ? 'sway_partner' : 'standard',
    shareUrl: share('/discover'),
    profileShareUrl: typeof handle === 'string' ? share(`/p/${encodeURIComponent(handle.toLowerCase())}`) : null,
    referralCount: Number(counts.rows[0]?.total ?? 0),
    commissions: earnings.rows,
    basis: 'captured_platform_fee',
    policyVersion: AFFILIATE_POLICY_VERSION,
    payoutStatus: 'not_available',
    payoutMessage: 'Affiliate cash-out is not available yet. Recorded commissions remain subject to refund, dispute, and payout review.'
  };
}

export function registerAffiliateRoutes(input: { app: Express; db: SwayDb | null; accessControl: AccessControl; isProduction: boolean }) {
  const { app, db, accessControl, isProduction } = input;
  // First valid explicit share lasts 30 days in this browser. The stable
  // account relationship begins at signup. Clean profiles do not silently
  // replace the sharer with the profile owner.
  app.use(async (req, res, next) => {
    const code = req.query.ref;
    if (!db || req.method !== 'GET' || req.path.startsWith('/api/') || typeof code !== 'string'
      || !CODE.test(code)) return next();
    const cleanUrl = new URL(req.originalUrl, ORIGIN);
    cleanUrl.searchParams.delete('ref');
    if (readAffiliateReferralCode(req)) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.redirect(302, `${cleanUrl.pathname}${cleanUrl.search}`);
    }
    try {
      const result = await db.execute(sql`SELECT a.user_id FROM affiliate_accounts a JOIN users u ON u.id = a.user_id WHERE a.code = ${code} AND u.email IS NOT NULL`);
      if (result.rows[0] && result.rows[0].user_id !== accessControl.resolveServerActor(req).actorId) {
        res.setHeader('Cache-Control', 'private, no-store');
        res.cookie(COOKIE, code, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 });
        return res.redirect(302, `${cleanUrl.pathname}${cleanUrl.search}`);
      }
    } catch (error) {
      // Referral attribution must not take public sites offline. A failed
      // lookup sets no cookie and never silently assigns a different owner.
      console.warn('Affiliate referral lookup unavailable.', error instanceof Error ? error.message : 'lookup_failed');
    }
    next();
  });

  app.get('/api/account/affiliate', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const access = await accessControl.requireAuthenticatedAccountAccess(req);
    if (access.allowed === false) return res.status(access.status).json({ error: access.reason });
    if (!db) return res.status(503).json({ error: 'Affiliate details are temporarily unavailable.' });
    try { return res.json(await loadAffiliateOverview(db, access.actor.actorId!)); }
    catch { return res.status(503).json({ error: 'Affiliate details are temporarily unavailable. Please retry.' }); }
  });

  app.post('/api/admin/sway-membership', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const access = await accessControl.requireAdminAccess(req);
    if (access.allowed === false) return res.status(access.status).json({ error: access.reason });
    if (!db) return res.status(503).json({ error: 'Membership changes require durable persistence.' });
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
    const performerId = typeof req.body?.performerId === 'string' ? req.body.performerId : null;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (Boolean(userId) === Boolean(performerId) || !UUID.test(userId || performerId || '') || reason.length < 4 || reason.length > 500
      || ['isFriend', 'isPartner', 'isExclusive'].some((key) => typeof req.body?.[key] !== 'boolean')) {
      return res.status(422).json({ error: 'Choose one account or performer, supply all membership flags, and give a reason.' });
    }
    if (req.headers.origin && isProduction && !['https://app.sway.tips', 'https://sway.tips', 'https://www.sway.tips'].includes(req.headers.origin)) {
      return res.status(403).json({ error: 'Use Sway to change memberships.' });
    }
    const isFriend = req.body.isFriend === true;
    const isPartner = isFriend || req.body.isPartner === true;
    const isExclusive = req.body.isExclusive === true;
    try {
      const membership = await db.transaction(async (tx) => {
        // Lock the canonical target before reading/upserting for truthful
        // before/after audit snapshots under concurrent admin changes.
        const target = userId
          ? await tx.execute(sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`)
          : await tx.execute(sql`SELECT id FROM performers WHERE id = ${performerId}::uuid FOR UPDATE`);
        if (!target.rows.length) return null;
        const before = await tx.execute(sql`SELECT * FROM sway_program_memberships WHERE user_id = ${userId}::uuid OR performer_id = ${performerId}::uuid`);
        const conflict = userId ? sql`user_id` : sql`performer_id`;
        const changed = await tx.execute(sql`INSERT INTO sway_program_memberships(user_id, performer_id, is_friend, is_partner, is_exclusive, reason)
          VALUES (${userId}::uuid, ${performerId}::uuid, ${isFriend}, ${isPartner}, ${isExclusive}, ${reason})
          ON CONFLICT (${conflict}) DO UPDATE SET is_friend = EXCLUDED.is_friend, is_partner = EXCLUDED.is_partner,
            is_exclusive = EXCLUDED.is_exclusive, reason = EXCLUDED.reason, updated_at = now() RETURNING *`);
        const after = changed.rows[0];
        await tx.execute(sql`INSERT INTO audit_events(actor_type, actor_id, entity_type, entity_id, event_type, metadata)
          VALUES ('operator', ${access.actor.actorId}::uuid, 'sway_program_membership', ${after.id}::uuid,
            'sway.membership.updated', ${JSON.stringify({ before: before.rows[0] ?? null, after, policyVersion: AFFILIATE_POLICY_VERSION })}::jsonb)`);
        return after;
      });
      if (!membership) return res.status(404).json({ error: 'Account or performer not found.' });
      return res.json({ membership });
    } catch { return res.status(503).json({ error: 'Membership could not be saved. Please retry.' }); }
  });
}
