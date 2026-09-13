import type { createPerformerWithdrawalService } from './performer-withdrawal-service';

type WithdrawalReconciler = Pick<ReturnType<typeof createPerformerWithdrawalService>, 'reconcilePending'>;

/** Keep provider readback running during a payout pause, without new sends. */
export function createPerformerPayoutReconciliationTick(input: {
  service: WithdrawalReconciler;
  executionEnabled: boolean;
  onError: (error: unknown) => void;
}) {
  let running = false;
  return async function tick() {
    if (running) return;
    running = true;
    try {
      await input.service.reconcilePending(25, { allowSubmissions: input.executionEnabled });
    } catch (error) {
      input.onError(error);
    } finally {
      running = false;
    }
  };
}
