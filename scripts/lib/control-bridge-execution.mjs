// An interrupted command is deliberately unresolved, never safe to replay.
// The player has no command-id deduplication, so reserve locally before I/O.
export function validateExecutionLedger(ledger) {
  if (!ledger || ledger.version !== 1 || typeof ledger.bridgeInstanceId !== 'string' || !ledger.bridgeInstanceId
    || !ledger.outcomes || typeof ledger.outcomes !== 'object' || Array.isArray(ledger.outcomes)
    || !Array.isArray(ledger.pendingCompletionIds)) throw new Error('Invalid bridge ledger structure.');
  for (const [id, outcome] of Object.entries(ledger.outcomes)) {
    if (!id || !outcome || typeof outcome.success !== 'boolean'
      || !outcome.result || typeof outcome.result !== 'object' || Array.isArray(outcome.result)
      || !(outcome.error === null || typeof outcome.error === 'string')
      || typeof outcome.finishedAt !== 'string' || !Number.isFinite(Date.parse(outcome.finishedAt))) {
      throw new Error('Invalid bridge execution outcome.');
    }
  }
  for (const id of ledger.pendingCompletionIds) {
    if (typeof id !== 'string' || !Object.hasOwn(ledger.outcomes, id)) {
      throw new Error('Pending bridge completion has no durable outcome.');
    }
  }
  return ledger;
}

export async function executeClaimedBatch(commands, executeOne) {
  for (const command of commands) {
    const outcome = await executeOne(command);
    // An ambiguous player response cannot authorize later actions in a batch.
    // Those still-unexecuted claims remain subject to the server lease rules.
    if (outcome?.result?.executionStatus === 'unknown') break;
  }
}

export async function executeClaimedOnce({ command, ledger, persist, execute, now = () => new Date().toISOString() }) {
  if (!command || typeof command.id !== 'string' || !command.id) {
    throw new Error('A durable Sway command identity is required.');
  }
  if (Object.hasOwn(ledger.outcomes, command.id)) {
    if (!ledger.pendingCompletionIds.includes(command.id)) {
      ledger.pendingCompletionIds.push(command.id);
      persist();
    }
    return ledger.outcomes[command.id];
  }
  ledger.outcomes[command.id] = {
    success: false,
    result: { executionStatus: 'unknown' },
    error: 'Player dispatch was interrupted or its outcome is unknown. Check the original player before issuing a new command; this command will not be replayed.',
    finishedAt: now()
  };
  ledger.pendingCompletionIds.push(command.id);
  // A failed write must prevent the external command. Keep the conservative
  // in-memory reservation if persistence failed; retry cannot create a replay.
  persist();
  let outcome;
  try {
    const result = await execute(command);
    const finishedAt = now();
    outcome = { success: true, result: { ...result, executedAt: finishedAt }, error: null, finishedAt };
  } catch (error) {
    outcome = {
      success: false,
      result: { executionStatus: 'unknown' },
      error: error instanceof Error ? error.message : String(error),
      finishedAt: now()
    };
  }
  ledger.outcomes[command.id] = outcome;
  persist();
  return outcome;
}
