import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const HANDLE_CONFLICT_CONSTRAINT = 'idx_performers_handle_lower';
const TRUE_OVERLAP_TIMEOUT_MS = 5_000;

const scenarios = [
  {
    name: 'canonical-first-reservation',
    winner: 'canonical',
    claimKind: 'reservation',
    targetHandle: 'race-can-res-11',
    canonicalOwnerId: '11000000-0000-4000-8000-000000000011',
    canonicalPerformerId: '31000000-0000-4000-8000-000000000011',
    canonicalBaseHandle: 'race_canonical_base_11',
    claimantOwnerId: '11000000-0000-4000-8000-000000000012',
    claimantPerformerId: '31000000-0000-4000-8000-000000000012',
    claimantBaseHandle: 'race_claimant_base_12'
  },
  {
    name: 'reservation-first-canonical',
    winner: 'claim',
    claimKind: 'reservation',
    targetHandle: 'race-res-can-21',
    canonicalOwnerId: '11000000-0000-4000-8000-000000000021',
    canonicalPerformerId: '31000000-0000-4000-8000-000000000021',
    canonicalBaseHandle: 'race_canonical_base_21',
    claimantOwnerId: '11000000-0000-4000-8000-000000000022',
    claimantPerformerId: '31000000-0000-4000-8000-000000000022',
    claimantBaseHandle: 'race_claimant_base_22'
  },
  {
    name: 'canonical-first-redirect',
    winner: 'canonical',
    claimKind: 'redirect',
    targetHandle: 'race-can-redir-31',
    canonicalOwnerId: '11000000-0000-4000-8000-000000000031',
    canonicalPerformerId: '31000000-0000-4000-8000-000000000031',
    canonicalBaseHandle: 'race_canonical_base_31',
    claimantOwnerId: '11000000-0000-4000-8000-000000000032',
    claimantPerformerId: '31000000-0000-4000-8000-000000000032',
    claimantBaseHandle: 'race_claimant_base_32'
  },
  {
    name: 'redirect-first-canonical',
    winner: 'claim',
    claimKind: 'redirect',
    targetHandle: 'race-redir-can-41',
    canonicalOwnerId: '11000000-0000-4000-8000-000000000041',
    canonicalPerformerId: '31000000-0000-4000-8000-000000000041',
    canonicalBaseHandle: 'race_canonical_base_41',
    claimantOwnerId: '11000000-0000-4000-8000-000000000042',
    claimantPerformerId: '31000000-0000-4000-8000-000000000042',
    claimantBaseHandle: 'race_claimant_base_42'
  }
];

function errorDetails(error) {
  if (!error || typeof error !== 'object') return {};
  return {
    code: 'code' in error ? error.code : undefined,
    constraint: 'constraint' in error ? error.constraint : undefined
  };
}

function assertHandleConflict(error, label) {
  const details = errorDetails(error);
  assert.equal(details.code, '23505', `${label} must lose with SQLSTATE 23505.`);
  assert.equal(
    details.constraint,
    HANDLE_CONFLICT_CONSTRAINT,
    `${label} must report the stable public handle-conflict constraint.`
  );
}

async function within(promise, label, timeoutMs = TRUE_OVERLAP_TIMEOUT_MS) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms; possible handle-namespace deadlock.`));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function watchAttempt(promise) {
  let settled = false;
  const outcome = promise
    .then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    )
    .finally(() => {
      settled = true;
    });
  return { outcome, isSettled: () => settled };
}

async function beginRepeatableRead(client, label) {
  await client.query('begin isolation level repeatable read');
  const isolation = await client.query('show transaction_isolation');
  assert.equal(isolation.rows[0]?.transaction_isolation, 'repeatable read', `${label} must use REPEATABLE READ.`);
  // Establish the transaction snapshot before either contender writes. This
  // exercises the stale-snapshot path after a competing transaction commits.
  await client.query('select count(*)::int as count from performer_handle_claims');
}

async function rollbackQuietly(client) {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original proof failure if the connection is already gone.
  }
}

async function writeCanonicalHandle(client, scenario) {
  return client.query(
    `update performers
        set handle = $1,
            updated_at = now()
      where id = $2
      returning id`,
    [scenario.targetHandle, scenario.canonicalPerformerId]
  );
}

async function writeNamespaceClaim(client, scenario) {
  return client.query(
    `insert into performer_handle_claims (
       normalized_handle,
       performer_id,
       claim_kind
     ) values (
       $1,
       $2,
       $3
     )
     returning normalized_handle`,
    [scenario.targetHandle, scenario.claimantPerformerId, scenario.claimKind]
  );
}

function contenderFor(clientByKind, kind, scenario) {
  return kind === 'canonical'
    ? () => writeCanonicalHandle(clientByKind.canonical, scenario)
    : () => writeNamespaceClaim(clientByKind.claim, scenario);
}

async function assertExactlyOneOwner(observer, scenario) {
  const claims = await observer.query(
    `select normalized_handle,
            performer_id::text,
            claim_kind
       from performer_handle_claims
      where normalized_handle = $1`,
    [scenario.targetHandle]
  );
  assert.equal(claims.rowCount, 1, `${scenario.name} must leave exactly one namespace owner.`);

  const canonicalOwners = await observer.query(
    `select id::text
       from performers
      where lower(handle) = $1`,
    [scenario.targetHandle]
  );

  if (scenario.winner === 'canonical') {
    assert.deepEqual(claims.rows, [{
      normalized_handle: scenario.targetHandle,
      performer_id: scenario.canonicalPerformerId,
      claim_kind: 'canonical'
    }]);
    assert.deepEqual(canonicalOwners.rows, [{ id: scenario.canonicalPerformerId }]);
  } else {
    assert.deepEqual(claims.rows, [{
      normalized_handle: scenario.targetHandle,
      performer_id: scenario.claimantPerformerId,
      claim_kind: scenario.claimKind
    }]);
    assert.equal(canonicalOwners.rowCount, 0, `${scenario.name} must not publish the losing canonical handle.`);
    const canonicalLoser = await observer.query(
      `select handle
         from performers
        where id = $1`,
      [scenario.canonicalPerformerId]
    );
    assert.equal(
      canonicalLoser.rows[0]?.handle,
      scenario.canonicalBaseHandle,
      `${scenario.name} must roll the losing performer write back completely.`
    );
  }
}

async function seedScenarios(client) {
  for (const [index, scenario] of scenarios.entries()) {
    await client.query(
      `insert into users (id, email, display_name, role)
       values ($1, $2, $3, 'performer'),
              ($4, $5, $6, 'performer')`,
      [
        scenario.canonicalOwnerId,
        `handle-race-canonical-${index}@example.test`,
        `Handle Race Canonical ${index}`,
        scenario.claimantOwnerId,
        `handle-race-claimant-${index}@example.test`,
        `Handle Race Claimant ${index}`
      ]
    );
    await client.query(
      `insert into performers (id, owner_user_id, handle, display_name)
       values ($1, $2, $3, $4),
              ($5, $6, $7, $8)`,
      [
        scenario.canonicalPerformerId,
        scenario.canonicalOwnerId,
        scenario.canonicalBaseHandle,
        `Handle Race Canonical Performer ${index}`,
        scenario.claimantPerformerId,
        scenario.claimantOwnerId,
        scenario.claimantBaseHandle,
        `Handle Race Claimant Performer ${index}`
      ]
    );
  }
}

async function runSerializedEmbeddedScenario(clients, scenario) {
  const winnerKind = scenario.winner;
  const loserKind = winnerKind === 'canonical' ? 'claim' : 'canonical';
  const winnerClient = clients[winnerKind];
  const loserClient = clients[loserKind];

  await beginRepeatableRead(winnerClient, `${scenario.name} embedded winner`);
  try {
    const winnerWrite = await contenderFor(clients, winnerKind, scenario)();
    assert.equal(winnerWrite.rowCount, 1, `${scenario.name} winner must write exactly once.`);
    await winnerClient.query('commit');
  } catch (error) {
    await rollbackQuietly(winnerClient);
    throw error;
  }

  await beginRepeatableRead(loserClient, `${scenario.name} embedded loser`);
  let loserError;
  try {
    await contenderFor(clients, loserKind, scenario)();
  } catch (error) {
    loserError = error;
  }
  assert.ok(loserError, `${scenario.name} embedded loser must be rejected.`);
  assertHandleConflict(loserError, `${scenario.name} embedded loser`);
  await rollbackQuietly(loserClient);

  await assertExactlyOneOwner(winnerClient, scenario);
}

async function runTrueOverlapScenario(clients, scenario) {
  const winnerKind = scenario.winner;
  const loserKind = winnerKind === 'canonical' ? 'claim' : 'canonical';
  const winnerClient = clients[winnerKind];
  const loserClient = clients[loserKind];

  await beginRepeatableRead(clients.canonical, `${scenario.name} canonical contender`);
  await beginRepeatableRead(clients.claim, `${scenario.name} claim contender`);

  try {
    const winnerWrite = await contenderFor(clients, winnerKind, scenario)();
    assert.equal(winnerWrite.rowCount, 1, `${scenario.name} winner must write exactly once.`);

    const loserAttempt = watchAttempt(contenderFor(clients, loserKind, scenario)());
    await delay(100);
    assert.equal(
      loserAttempt.isSettled(),
      false,
      `${scenario.name} loser must block behind the uncommitted namespace owner.`
    );

    await winnerClient.query('commit');
    const loserOutcome = await within(loserAttempt.outcome, `${scenario.name} loser completion`);
    assert.equal(loserOutcome.status, 'rejected', `${scenario.name} loser must reject after the winner commits.`);
    assertHandleConflict(loserOutcome.reason, `${scenario.name} loser`);
    await rollbackQuietly(loserClient);
  } catch (error) {
    await Promise.all([rollbackQuietly(clients.canonical), rollbackQuietly(clients.claim)]);
    throw error;
  }

  await assertExactlyOneOwner(winnerClient, scenario);
}

const proof = await startEmbeddedPostgresProof('performer_handle_claim_race');
const canonicalClient = new Client({ connectionString: proof.databaseUrl });
const claimClient = new Client({ connectionString: proof.databaseUrl });

try {
  await canonicalClient.connect();
  await claimClient.connect();
  const clients = { canonical: canonicalClient, claim: claimClient };
  await seedScenarios(canonicalClient);

  if (proof.kind === 'real-postgres') {
    for (const scenario of scenarios) {
      await runTrueOverlapScenario(clients, scenario);
    }
    console.log('PASS real PostgreSQL two-client REPEATABLE READ handle-claim overlap proof (4 orderings).');
  } else {
    for (const scenario of scenarios) {
      await runSerializedEmbeddedScenario(clients, scenario);
    }
    console.log('PASS embedded PostgreSQL-protocol serialized handle-claim collision proof (4 orderings).');
    console.log('SKIP true-overlap REPEATABLE READ proof: SWAY_REAL_POSTGRES_PROOF_DATABASE_URL is not configured.');
  }
} finally {
  await Promise.allSettled([canonicalClient.end(), claimClient.end()]);
  await proof.close();
}
