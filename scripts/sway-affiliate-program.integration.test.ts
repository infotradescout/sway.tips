import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';
import { createSwayDb, closeDisposableSwayDbProof } from '../src/db/client';
import { createAccessControl } from '../src/server/access-control';
import { createPerformerSessionStore } from '../src/server/performer-session-store';
import { bindAffiliateReferral, loadAffiliateOverview, loadSwayProgramMembership, registerAffiliateRoutes } from '../src/server/affiliate-program';

const proof = await startEmbeddedPostgresProof('affiliate-program');
const db = createSwayDb(proof.databaseUrl);
const sessions = createPerformerSessionStore({ databaseUrl: proof.databaseUrl, dbOverride: db });
const actors: Record<string, string> = {};
let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
try {
  for (const role of ['patron', 'performer', 'admin', 'support']) {
    actors[role] = randomUUID();
    await proof.query('INSERT INTO users(id, email, display_name, role, email_verified_at) VALUES ($1, $2, $3, $4, now())', [actors[role], `${role}@affiliate.sway.test`, role, role]);
  }
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_accounts')).rows[0].n, 4, 'all roles automatically enrolled');
  const standard = await loadAffiliateOverview(db, actors.patron);
  assert.equal(standard.rateBps, 1000);
  assert.equal(standard.code, (await loadAffiliateOverview(db, actors.patron)).code);
  assert.equal(standard.enrolled, true);
  assert.equal(standard.payoutStatus, 'not_available');
  // Execute the migration's actual legacy enrollment statement against a
  // missing identity, then repeat to prove safe repairs and unique identity.
  await proof.query('DELETE FROM affiliate_accounts WHERE user_id = $1', [actors.support]);
  const migration = readFileSync('drizzle/0050_automatic_affiliates.sql', 'utf8');
  const backfill = migration.match(/INSERT INTO affiliate_accounts\(user_id\) SELECT id FROM users ON CONFLICT \(user_id\) DO NOTHING;/)?.[0];
  assert.ok(backfill);
  await proof.query(backfill);
  await proof.query(backfill);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_accounts')).rows[0].n, 4);
  await assert.rejects(proof.query("INSERT INTO sway_program_memberships(user_id, is_friend, reason) VALUES ($1, true, 'bad friend flags')", [actors.support]), /friend_partner/);
  await proof.query("INSERT INTO sway_program_memberships(user_id, is_friend, is_partner, reason) VALUES ($1, true, true, 'owner-confirmed friend')", [actors.performer]);
  await proof.query("INSERT INTO sway_program_memberships(user_id, is_exclusive, reason) VALUES ($1, true, 'exclusive recognition')", [actors.support]);
  assert.equal((await loadSwayProgramMembership(db, actors.performer)).rateBps, 2000);
  assert.equal((await loadSwayProgramMembership(db, actors.support)).rateBps, 2000);
  await proof.query('UPDATE sway_program_memberships SET is_partner = true WHERE user_id = $1', [actors.support]);
  assert.equal((await loadSwayProgramMembership(db, actors.support)).rateBps, 2000, '20% plus20% does not stack');
  const partner = await loadAffiliateOverview(db, actors.performer);
  const exclusive = await loadAffiliateOverview(db, actors.support);
  const buyer = randomUUID();
  await proof.query("INSERT INTO users(id, email, role) VALUES ($1, 'buyer@affiliate.sway.test', 'patron')", [buyer]);
  await bindAffiliateReferral(db, buyer, partner.code);
  await bindAffiliateReferral(db, buyer, standard.code);
  await bindAffiliateReferral(db, buyer, partner.code);
  assert.equal((await loadAffiliateOverview(db, actors.performer)).referralCount, 1);
  assert.equal((await loadAffiliateOverview(db, actors.patron)).referralCount, 0);
  await bindAffiliateReferral(db, actors.performer, partner.code);
  assert.equal((await loadAffiliateOverview(db, actors.performer)).referralCount, 1, 'self referral rejected');
  const accountId = (await proof.query('SELECT id FROM affiliate_accounts WHERE user_id = $1', [actors.performer])).rows[0].id;
  await assert.rejects(proof.query('INSERT INTO affiliate_referrals(referred_user_id, affiliate_account_id) VALUES ($1, $2)', [actors.performer, accountId]), /invalid_or_self/);
  await assert.rejects(proof.query('UPDATE affiliate_referrals SET affiliate_account_id = affiliate_account_id WHERE referred_user_id = $1', [buyer]), /immutable/);

  const performer = randomUUID(), gig = randomUUID();
  await proof.query("INSERT INTO performers(id, owner_user_id, handle, display_name, is_active, onboarding_status) VALUES ($1, $2, 'affiliate-seller', 'Seller', true, 'gig_ready')", [performer, actors.admin]);
  await proof.query("INSERT INTO gig_sessions(id, performer_id, status, auto_closeout_at) VALUES ($1, $2, 'active', now() + interval '4 hours')", [gig, performer]);
  async function payment(payer: string | null, mode = 'test', fee = 105, boostOf?: string) {
    const requestId = boostOf ?? randomUUID(), paymentId = randomUUID(), boostId = boostOf ? randomUUID() : null;
    if (!boostOf) await proof.query("INSERT INTO requests(id, gig_id, patron_user_id, client_request_id, request_type, amount_cents) VALUES ($1, $2, $3, $4, 'tip', 10000)", [requestId, gig, payer, randomUUID()]);
    else await proof.query("INSERT INTO request_boosts(id, request_id, gig_id, patron_user_id, client_request_id, amount_cents) VALUES ($1, $2, $3, $4, $5, 10000)", [boostId, requestId, gig, payer, randomUUID()]);
    await proof.query(`INSERT INTO payments(id, gig_id, performer_id, request_id, request_boost_id, action_type, idempotency_key, destination_account_id, payment_mode, legacy_unlinked, payment_status, processor, amount_subtotal, platform_fee, processor_fee_recovery, amount_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'affiliate_disposable_destination', $8, false, 'authorized', 'mock', 10000, $9, 400, $10)`, [paymentId, gig, performer, boostOf ? null : requestId, boostId, boostOf ? 'boost' : 'tip', randomUUID(), mode, fee, 10400 + fee]);
    await proof.query("UPDATE payments SET payment_status = 'captured' WHERE id = $1", [paymentId]);
    return { paymentId, requestId };
  }
  const captured = await payment(buyer);
  const first = (await proof.query('SELECT * FROM affiliate_commission_events WHERE payment_id = $1', [captured.paymentId])).rows[0];
  assert.equal(first.source_amount_cents, 105);
  assert.equal(first.amount_cents, 21, 'commission comes from actual fee, not gross or processing recovery');
  assert.equal(first.rate_bps, 2000);
  await proof.query("UPDATE payments SET payment_status = 'captured' WHERE id = $1", [captured.paymentId]);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_commission_events WHERE payment_id = $1', [captured.paymentId])).rows[0].n, 1);
  await proof.query('UPDATE sway_program_memberships SET is_friend = false, is_partner = false WHERE user_id = $1', [actors.performer]);
  const newRate = await payment(buyer, 'test', 105);
  assert.equal((await proof.query('SELECT amount_cents FROM affiliate_commission_events WHERE payment_id = $1', [newRate.paymentId])).rows[0].amount_cents, 11, 'half-up cents and changed tier');
  assert.deepEqual((await proof.query('SELECT * FROM affiliate_commission_events WHERE payment_id = $1', [captured.paymentId])).rows[0], first, 'historic rate snapshot unchanged');
  await assert.rejects(proof.query('UPDATE affiliate_commission_events SET amount_cents = 999 WHERE payment_id = $1', [captured.paymentId]), /immutable/);
  await assert.rejects(proof.query('DELETE FROM affiliate_commission_events WHERE payment_id = $1', [captured.paymentId]), /immutable/);
  await proof.query("UPDATE payments SET payment_status = 'disputed' WHERE id = $1", [captured.paymentId]);
  let view = await loadAffiliateOverview(db, actors.performer);
  assert.equal(view.commissions[0].heldCents, '21');
  await proof.query("UPDATE payments SET payment_status = 'paid_out', refund_status = 'pending' WHERE id = $1", [captured.paymentId]);
  assert.equal((await loadAffiliateOverview(db, actors.performer)).commissions[0].heldCents, '21');
  await proof.query("UPDATE payments SET payment_status = 'refunded', refund_status = 'refunded' WHERE id = $1", [captured.paymentId]);
  await proof.query("UPDATE payments SET refund_status = 'refunded' WHERE id = $1", [captured.paymentId]);
  const reversed = (await proof.query('SELECT event_kind, amount_cents, rate_bps FROM affiliate_commission_events WHERE payment_id = $1 ORDER BY event_kind', [captured.paymentId])).rows;
  assert.deepEqual(reversed, [{ event_kind: 'earned', amount_cents: 21, rate_bps: 2000 }, { event_kind: 'reversed', amount_cents: -21, rate_bps: 2000 }]);
  await payment(buyer, 'live', 1000);
  view = await loadAffiliateOverview(db, actors.performer);
  assert.equal(view.commissions.find((row) => row.paymentMode === 'live')?.netCents, '100');
  assert.equal(view.commissions.find((row) => row.paymentMode === 'test')?.netCents, '11');
  const guest = await payment(null);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_commission_events WHERE payment_id = $1', [guest.paymentId])).rows[0].n, 0);
  // A boost belongs to its own payer. The original request's attribution
  // must not leak into the second person's payment.
  const boost = await payment(null, 'test', 105, captured.requestId);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_commission_events WHERE payment_id = $1', [boost.paymentId])).rows[0].n, 0);
  const cleanup = randomUUID();
  await proof.query("INSERT INTO users(id, email) VALUES ($1, 'failed-signup@affiliate.sway.test')", [cleanup]);
  await bindAffiliateReferral(db, cleanup, exclusive.code);
  await proof.query('DELETE FROM users WHERE id = $1', [cleanup]);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_accounts WHERE user_id = $1', [cleanup])).rows[0].n, 0);

  // HTTP guards exercise the real persisted session/access-control owner.
  const app = express(); app.use(express.json());
  const accessControl = createAccessControl({ databaseUrl: proof.databaseUrl, dbOverride: db, performerSessionStoreOverride: sessions, isProduction: false });
  app.use(async (req, _res, next) => { try { await accessControl.hydrateRequestActor(req); next(); } catch (error) { next(error); } });
  registerAffiliateRoutes({ app, db, accessControl, isProduction: false });
  app.get('/discover', (_req, res) => res.send('Discover'));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = async (id: string) => { const session = await sessions.issueSession({ actorUserId: id, issuedBy: id }); return `${sessions.cookieName}=${session.token}`; };
  assert.equal((await fetch(`${base}/api/account/affiliate`)).status, 401);
  assert.equal((await fetch(`${base}/api/account/affiliate`, { headers: { 'x-actor-user-id': actors.admin } })).status, 401);
  const patronCookie = await cookie(actors.patron);
  const read = await fetch(`${base}/api/account/affiliate?userId=${actors.performer}`, { headers: { cookie: patronCookie } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).code, standard.code, 'caller cannot read another account using a query ID');
  const body = JSON.stringify({ userId: actors.patron, isFriend: true, isPartner: false, isExclusive: false, reason: 'owner-confirmed new friend' });
  assert.equal((await fetch(`${base}/api/admin/sway-membership`, { method: 'POST', headers: { cookie: patronCookie, 'content-type': 'application/json' }, body })).status, 403);
  const adminCookie = await cookie(actors.admin);
  assert.equal((await fetch(`${base}/api/admin/sway-membership`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body })).status, 200);
  assert.equal((await loadAffiliateOverview(db, actors.patron)).rateBps, 2000);
  assert.equal((await proof.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'sway.membership.updated'")).rows[0].n, 1);
  const referredVisit = await fetch(`${base}/discover?ref=${standard.code}`, { redirect: 'manual' });
  assert.equal(referredVisit.status, 302);
  assert.equal(referredVisit.headers.get('location'), '/discover');
  assert.match(referredVisit.headers.get('cache-control') || '', /no-store/);
  const referralCookie = referredVisit.headers.get('set-cookie')!;
  assert.match(referralCookie, /HttpOnly/);
  assert.match(referralCookie, /SameSite=Lax/);
  const repeated = await fetch(`${base}/discover?ref=${partner.code}`, { redirect: 'manual', headers: { cookie: referralCookie.split(';')[0] } });
  assert.equal(repeated.headers.get('set-cookie'), null, 'later share does not replace first touch');
  const self = await fetch(`${base}/discover?ref=${standard.code}`, { redirect: 'manual', headers: { cookie: patronCookie } });
  assert.equal(self.headers.get('set-cookie'), null);
  console.log('Affiliate program PASS: every role, identity repair, first attribution, self guards,20%/10%, rate snapshots, captured fee basis, duplicate capture/refund, holds, test/live isolation, boost payer, cleanup, real HTTP sessions, admin isolation, private referral redirects. Embedded proof does not claim independent-backend concurrency or external money transfer.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
  await closeDisposableSwayDbProof(proof.databaseUrl);
  await proof.close();
}
