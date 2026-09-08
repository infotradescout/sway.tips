-- Owner policy, 2026-09-08: every user is an affiliate; Partners and
-- Exclusives earn 20%, everyone else 10% of eligible captured Sway fees.
-- Membership recognition is separate from signed legacy fee contracts.
CREATE TABLE sway_program_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid CONSTRAINT sway_program_memberships_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  performer_id uuid CONSTRAINT sway_program_memberships_performer_id_performers_id_fk REFERENCES performers(id) ON DELETE CASCADE,
  is_friend boolean NOT NULL DEFAULT false,
  is_partner boolean NOT NULL DEFAULT false,
  is_exclusive boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sway_program_memberships_target CHECK ((user_id IS NULL) <> (performer_id IS NULL)),
  CONSTRAINT sway_program_memberships_friend_partner CHECK (NOT is_friend OR is_partner)
);
CREATE UNIQUE INDEX sway_program_memberships_user_idx ON sway_program_memberships(user_id);
CREATE UNIQUE INDEX sway_program_memberships_performer_idx ON sway_program_memberships(performer_id);
--> statement-breakpoint
CREATE TABLE affiliate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL CONSTRAINT affiliate_accounts_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_accounts_code_shape CHECK (code ~ '^[a-f0-9]{32}$')
);
CREATE UNIQUE INDEX affiliate_accounts_user_idx ON affiliate_accounts(user_id);
CREATE UNIQUE INDEX affiliate_accounts_code_idx ON affiliate_accounts(code);
--> statement-breakpoint
CREATE TABLE affiliate_referrals (
  referred_user_id uuid PRIMARY KEY CONSTRAINT affiliate_referrals_referred_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  -- Retain first attribution even if the referrer account is removed. No
  -- direct personal data; a missing beneficiary cannot receive a commission.
  affiliate_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliate_referrals_account_idx ON affiliate_referrals(affiliate_account_id);
--> statement-breakpoint
CREATE TABLE affiliate_commission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Immutable financial identifiers intentionally have no cascading FKs.
  payment_id uuid NOT NULL,
  affiliate_account_id uuid NOT NULL,
  referred_user_id uuid NOT NULL,
  event_kind text NOT NULL,
  payment_mode text NOT NULL,
  currency text NOT NULL,
  source_amount_cents integer NOT NULL,
  rate_bps integer NOT NULL,
  amount_cents integer NOT NULL,
  basis text NOT NULL DEFAULT 'captured_platform_fee',
  policy_version text NOT NULL DEFAULT '2026-09-08',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_commission_events_kind CHECK (event_kind IN ('earned', 'reversed')),
  CONSTRAINT affiliate_commission_events_mode CHECK (payment_mode IN ('test', 'live')),
  CONSTRAINT affiliate_commission_events_rate CHECK (rate_bps IN (1000, 2000)),
  CONSTRAINT affiliate_commission_events_amount CHECK (source_amount_cents >= 0 AND ((event_kind = 'earned' AND amount_cents >= 0) OR (event_kind = 'reversed' AND amount_cents <= 0))),
  CONSTRAINT affiliate_commission_events_basis CHECK (basis = 'captured_platform_fee')
);
CREATE UNIQUE INDEX affiliate_commission_events_payment_kind_idx ON affiliate_commission_events(payment_id, event_kind);
CREATE INDEX affiliate_commission_events_account_mode_idx ON affiliate_commission_events(affiliate_account_id, payment_mode);
--> statement-breakpoint
CREATE FUNCTION sway_enroll_affiliate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO affiliate_accounts(user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_automatic_affiliate AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION sway_enroll_affiliate();
INSERT INTO affiliate_accounts(user_id) SELECT id FROM users ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION sway_affiliate_referral_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'affiliate_attribution_is_immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM affiliate_accounts a JOIN users u ON u.id = a.user_id
    WHERE a.id = NEW.affiliate_account_id AND a.user_id <> NEW.referred_user_id AND u.email IS NOT NULL)
  THEN RAISE EXCEPTION 'invalid_or_self_affiliate_referral'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER affiliate_referrals_identity_guard BEFORE INSERT OR UPDATE ON affiliate_referrals FOR EACH ROW EXECUTE FUNCTION sway_affiliate_referral_guard();
--> statement-breakpoint
CREATE FUNCTION sway_affiliate_rate_bps(target_user_id uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sway_program_memberships m LEFT JOIN performers p ON p.id = m.performer_id
    WHERE (m.user_id = target_user_id OR p.owner_user_id = target_user_id)
      AND (m.is_partner OR m.is_exclusive)
  ) OR EXISTS (
    SELECT 1 FROM performer_partner_entitlements e JOIN performers p ON p.id = e.performer_id
    WHERE p.owner_user_id = target_user_id AND e.partner_kind = 'brand'
      AND EXISTS (SELECT 1 FROM performer_partner_terms_acceptances a
        WHERE a.entitlement_id = e.id AND a.account_user_id = target_user_id
          AND a.terms_version = e.terms_version AND a.terms_hash = e.terms_hash)
      AND (SELECT s.status FROM performer_partner_entitlement_status_events s
        WHERE s.entitlement_id = e.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'active'
  ) THEN 2000 ELSE 1000 END;
$$;
--> statement-breakpoint
-- Five explicitly named friends. Performer-scoped recognition follows the
-- same artist through the existing authenticated handoff/claim transaction.
INSERT INTO sway_program_memberships(performer_id, is_friend, is_partner, reason)
SELECT p.id, true, true, 'Owner-confirmed friend and automatic Sway Partner, 2026-09-08'
FROM performers p
WHERE (p.id, lower(p.handle), p.display_name) IN (
  ('b1b0e4d9-d4a8-4526-b49a-f5c4e464cfcd'::uuid, 'bubbakhain', 'Bubba Khain'),
  ('ed8116ce-8255-4ff8-bfec-6a57ec9568cf'::uuid, 'calliehines', 'Callie Hines'),
  ('da855e85-9f7a-469e-9d9d-8c8e1ce20b96'::uuid, 'coreymack', 'Corey Mack'),
  ('bc1c60c2-2ec1-4967-ad2f-b099adfcbb7c'::uuid, 'drewmaze', 'Drew Maze')
)
ON CONFLICT (performer_id) DO NOTHING;
INSERT INTO sway_program_memberships(performer_id, is_friend, is_partner, reason)
SELECT p.id, true, true, 'Owner-confirmed friend and automatic Sway Partner, 2026-09-08'
FROM performers p JOIN users u ON u.id = p.owner_user_id
WHERE lower(p.handle) = 'dj3x' AND p.display_name = 'Frank DJ3X Broughton'
  AND p.is_active AND p.visibility_state = 'public' AND u.email_verified_at IS NOT NULL
ON CONFLICT (performer_id) DO NOTHING;
INSERT INTO audit_events(actor_type, entity_type, entity_id, event_type, next_status, metadata)
SELECT 'operator', 'sway_program_membership', m.id, 'sway.partner.owner_friend_grant', 'partner',
  jsonb_build_object('performerId', m.performer_id, 'isFriend', true, 'affiliateRateBps', 2000, 'authority', 'owner_instruction_2026-09-08')
FROM sway_program_memberships m WHERE m.is_friend;
--> statement-breakpoint
-- A single atomic ledger owner at the persisted payment boundary handles
-- provider webhook, direct capture, retries, refunds, and reconciliation.
-- No old payments are backfilled and test mode never becomes live earnings.
CREATE FUNCTION sway_record_affiliate_commission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payer uuid; beneficiary uuid; rate integer; earned affiliate_commission_events%ROWTYPE;
BEGIN
  IF NEW.payment_status = 'captured' AND (TG_OP = 'INSERT' OR OLD.payment_status IS DISTINCT FROM NEW.payment_status)
    AND NOT NEW.legacy_unlinked AND NEW.platform_fee > 0
  THEN
    IF NEW.request_boost_id IS NOT NULL THEN
      SELECT patron_user_id INTO payer FROM request_boosts WHERE id = NEW.request_boost_id AND gig_id = NEW.gig_id;
    ELSE
      SELECT patron_user_id INTO payer FROM requests WHERE id = NEW.request_id AND gig_id = NEW.gig_id;
    END IF;
    SELECT a.id, sway_affiliate_rate_bps(a.user_id) INTO beneficiary, rate
      FROM affiliate_referrals r JOIN affiliate_accounts a ON a.id = r.affiliate_account_id
      JOIN users u ON u.id = a.user_id
      WHERE r.referred_user_id = payer AND a.user_id <> payer AND u.email IS NOT NULL;
    IF beneficiary IS NOT NULL THEN
      INSERT INTO affiliate_commission_events(payment_id, affiliate_account_id, referred_user_id,
        event_kind, payment_mode, currency, source_amount_cents, rate_bps, amount_cents)
      VALUES (NEW.id, beneficiary, payer, 'earned', NEW.payment_mode, upper(NEW.currency),
        NEW.platform_fee, rate, ((NEW.platform_fee::bigint * rate + 5000) / 10000)::integer)
      ON CONFLICT (payment_id, event_kind) DO NOTHING;
    END IF;
  END IF;
  IF NEW.payment_status = 'refunded' OR NEW.refund_status = 'refunded' THEN
    SELECT * INTO earned FROM affiliate_commission_events WHERE payment_id = NEW.id AND event_kind = 'earned';
    IF FOUND THEN
      INSERT INTO affiliate_commission_events(payment_id, affiliate_account_id, referred_user_id,
        event_kind, payment_mode, currency, source_amount_cents, rate_bps, amount_cents, basis, policy_version)
      VALUES (earned.payment_id, earned.affiliate_account_id, earned.referred_user_id, 'reversed',
        earned.payment_mode, earned.currency, earned.source_amount_cents, earned.rate_bps,
        -earned.amount_cents, earned.basis, earned.policy_version)
      ON CONFLICT (payment_id, event_kind) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_affiliate_commission AFTER INSERT OR UPDATE OF payment_status, refund_status ON payments
  FOR EACH ROW EXECUTE FUNCTION sway_record_affiliate_commission();
--> statement-breakpoint
CREATE FUNCTION sway_affiliate_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'affiliate_commission_events_are_immutable'; END;
$$;
CREATE TRIGGER affiliate_commission_events_immutable BEFORE UPDATE OR DELETE ON affiliate_commission_events
  FOR EACH ROW EXECUTE FUNCTION sway_affiliate_ledger_immutable();
