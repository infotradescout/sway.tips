CREATE OR REPLACE FUNCTION "sway_sync_live_room_money_projection"() RETURNS trigger AS $$
DECLARE
  legacy_money_requested boolean;
  legacy_projection_changed boolean;
  relational_money_changed boolean;
  projected_environment text;
  projected_settlement_mode text;
  projected_payments_enabled boolean;
  projected_tips_enabled boolean;
  connected_account_id text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.status IN ('active', 'closeout_pending')
    AND NEW.room_type IS DISTINCT FROM OLD.room_type THEN
    RAISE EXCEPTION 'Room type is immutable after a room becomes active.'
      USING ERRCODE = '23514', CONSTRAINT = 'gig_sessions_active_room_type_immutable';
  END IF;

  projected_payments_enabled := coalesce(NEW.runtime_session_state->>'paymentsEnabled', 'false') = 'true';
  projected_tips_enabled := coalesce(NEW.runtime_session_state->>'tipsEnabled', 'false') = 'true';
  legacy_money_requested := projected_payments_enabled OR projected_tips_enabled;
  IF NEW.room_type <> 'music' AND legacy_money_requested THEN
    RAISE EXCEPTION 'Nonmusic rooms cannot project paid requests or tips.'
      USING ERRCODE = '23514', CONSTRAINT = 'gig_sessions_nonmusic_money_projection';
  END IF;

  IF TG_OP = 'INSERT' THEN
    legacy_projection_changed := true;
    relational_money_changed := NEW.money_enabled
      OR NEW.money_destination_account_id IS NOT NULL
      OR NEW.money_environment IS NOT NULL;
  ELSE
    legacy_projection_changed :=
      coalesce(NEW.runtime_session_state->>'paymentsEnabled', 'false')
        IS DISTINCT FROM coalesce(OLD.runtime_session_state->>'paymentsEnabled', 'false')
      OR coalesce(NEW.runtime_session_state->>'tipsEnabled', 'false')
        IS DISTINCT FROM coalesce(OLD.runtime_session_state->>'tipsEnabled', 'false');
    relational_money_changed := NEW.money_enabled IS DISTINCT FROM OLD.money_enabled
      OR NEW.money_destination_account_id IS DISTINCT FROM OLD.money_destination_account_id
      OR NEW.money_environment IS DISTINCT FROM OLD.money_environment;
  END IF;

  IF legacy_projection_changed AND NOT relational_money_changed THEN
    IF legacy_money_requested THEN
      projected_environment := NEW.runtime_session_state->>'paymentEnvironment';
      projected_settlement_mode := NEW.runtime_session_state->>'settlementMode';
      IF projected_environment NOT IN ('test', 'live') THEN
        RAISE EXCEPTION 'Legacy paid room writes require an exact test or live environment.' USING ERRCODE = '42501';
      END IF;
      SELECT performer.stripe_connected_account_id INTO connected_account_id
      FROM performers performer
      WHERE performer.id = NEW.performer_id;
      NEW.money_destination_account_id := CASE
        WHEN projected_settlement_mode = 'platform_test_balance' AND projected_environment = 'test'
          THEN 'sway_test_platform_balance'
        WHEN projected_settlement_mode = 'connected_account'
          THEN nullif(trim(connected_account_id), '')
        ELSE NULL
      END;
      IF NEW.money_destination_account_id IS NULL THEN
        RAISE EXCEPTION 'Legacy paid room write has no exact durable payout destination.' USING ERRCODE = '42501';
      END IF;
      NEW.money_enabled := true;
      NEW.money_environment := projected_environment;
    ELSE
      NEW.money_enabled := false;
      NEW.money_destination_account_id := NULL;
      NEW.money_environment := NULL;
    END IF;
  END IF;

  IF NEW.money_enabled THEN
    -- The relational flag means some money behavior is enabled. The JSON
    -- projection retains which behavior: paid requests, direct tips, or both.
    -- Relational-only legacy writes have no subtype, so keep their historical
    -- both-enabled projection instead of silently disabling money behavior.
    IF NOT (projected_payments_enabled OR projected_tips_enabled) THEN
      projected_payments_enabled := true;
      projected_tips_enabled := true;
    END IF;
    NEW.runtime_session_state := coalesce(NEW.runtime_session_state, '{}'::jsonb)
      || jsonb_build_object(
        'paymentsEnabled', projected_payments_enabled,
        'tipsEnabled', projected_tips_enabled,
        'settlementMode', CASE
          WHEN NEW.money_destination_account_id = 'sway_test_platform_balance' THEN 'platform_test_balance'
          ELSE 'connected_account'
        END,
        'paymentEnvironment', NEW.money_environment
      );
  ELSE
    NEW.money_destination_account_id := NULL;
    NEW.money_environment := NULL;
    NEW.runtime_session_state := coalesce(NEW.runtime_session_state, '{}'::jsonb)
      || jsonb_build_object(
        'paymentsEnabled', false,
        'tipsEnabled', false,
        'settlementMode', 'unavailable',
        'paymentEnvironment', 'unavailable'
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
