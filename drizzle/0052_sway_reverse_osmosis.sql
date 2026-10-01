ALTER TABLE performers ADD COLUMN IF NOT EXISTS public_profile_revision integer NOT NULL DEFAULT 0;
CREATE TABLE sway_ro_business_bindings (
 id uuid PRIMARY KEY,
 performer_id uuid NOT NULL CONSTRAINT sway_ro_business_bindings_performer_id_performers_id_fk REFERENCES performers(id),
 owner_id uuid NOT NULL CONSTRAINT sway_ro_business_bindings_owner_id_users_id_fk REFERENCES users(id),
 business_id text NOT NULL, tenant_id text NOT NULL, provider text NOT NULL, account_id text NOT NULL,
 asset_kind text NOT NULL, provider_verified boolean NOT NULL, owner_authorized boolean NOT NULL,
 verified_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 revision text NOT NULL, evidence_reference text NOT NULL,
 CONSTRAINT sway_ro_business_bindings_performer_id_provider_account_id_key UNIQUE (performer_id, provider, account_id)
);
CREATE TABLE sway_ro_proposals (
 id uuid PRIMARY KEY,
 binding_id uuid NOT NULL CONSTRAINT sway_ro_proposals_binding_id_sway_ro_business_bindings_id_fk REFERENCES sway_ro_business_bindings(id),
 performer_id uuid NOT NULL CONSTRAINT sway_ro_proposals_performer_id_performers_id_fk REFERENCES performers(id),
 actor_id uuid NOT NULL CONSTRAINT sway_ro_proposals_actor_id_users_id_fk REFERENCES users(id),
 operation_key text NOT NULL CONSTRAINT sway_ro_proposals_operation_key_unique UNIQUE,
 payload_digest text NOT NULL, proposal jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sway_ro_approvals (
 id uuid PRIMARY KEY,
 proposal_id uuid NOT NULL CONSTRAINT sway_ro_approvals_proposal_id_unique UNIQUE
 CONSTRAINT sway_ro_approvals_proposal_id_sway_ro_proposals_id_fk REFERENCES sway_ro_proposals(id),
 actor_id uuid NOT NULL CONSTRAINT sway_ro_approvals_actor_id_users_id_fk REFERENCES users(id), approval jsonb NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sway_ro_operations (
 operation_key text PRIMARY KEY,
 proposal_id uuid NOT NULL CONSTRAINT sway_ro_operations_proposal_id_unique UNIQUE
 CONSTRAINT sway_ro_operations_proposal_id_sway_ro_proposals_id_fk REFERENCES sway_ro_proposals(id),
 payload_digest text NOT NULL,
 approval_id uuid NOT NULL CONSTRAINT sway_ro_operations_approval_id_sway_ro_approvals_id_fk REFERENCES sway_ro_approvals(id),
 claim_token text NOT NULL,
 status text NOT NULL CONSTRAINT sway_ro_operations_status_check CHECK(status IN ('claimed','completed','held','denied','reflected','absent')),
 receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION sway_ro_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'sway_ro_approvals' AND TG_OP = 'UPDATE' THEN
 IF
    NEW.id = OLD.id AND NEW.proposal_id = OLD.proposal_id AND NEW.actor_id = OLD.actor_id AND
    NEW.approval = OLD.approval AND NEW.expires_at = OLD.expires_at AND NEW.created_at = OLD.created_at AND
    (OLD.revoked_at IS NULL OR NEW.revoked_at = OLD.revoked_at)
 THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Reverse Osmosis reviewed records are immutable';
END $$;
CREATE TRIGGER sway_ro_proposal_immutable BEFORE UPDATE OR DELETE ON sway_ro_proposals FOR EACH ROW EXECUTE FUNCTION sway_ro_immutable_record();
CREATE TRIGGER sway_ro_approval_immutable BEFORE UPDATE OR DELETE ON sway_ro_approvals FOR EACH ROW EXECUTE FUNCTION sway_ro_immutable_record();
