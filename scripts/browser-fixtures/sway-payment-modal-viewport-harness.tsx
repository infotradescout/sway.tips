import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { installViewportEnvironment } from '../../src/browserEnvironment';
import PatronView from '../../src/components/PatronView';
import type { GigSession } from '../../src/types';

const gigId = '55555555-5555-4555-8555-555555555555';

const session: GigSession = {
  status: 'active',
  startedAt: new Date().toISOString(),
  autoCloseoutAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  closedAt: null,
  talentName: 'Viewport Test Performer',
  talentRole: 'DJ',
  roomType: 'music',
  requestMenu: [{
    id: 'fixture-song-request',
    title: 'Fixture song request',
    description: 'A safe host-defined request used only by the viewport test.',
    targetType: 'music'
  }],
  linkedEventId: null,
  linkedEvent: null,
  feeType: 'patron',
  minimumTip: 5,
  endGigTimerStartedAt: null,
  isFeatured: false,
  featuredExpiresAt: null,
  featuredCost: 0,
  featuredDurationHours: 0,
  requestsOpen: true,
  requestWindowMode: 'manual',
  requestWindowExpiresAt: null,
  requestWindowDuration: null,
  requestWindowLabel: null,
  requestPresets: [],
  operatingMode: 'manual',
  searchScope: 'library',
  paymentsEnabled: true,
  tipsEnabled: true,
  settlementMode: 'platform_test_balance',
  paymentEnvironment: 'test',
  totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: '' }
};

installViewportEnvironment();

const fixtureParams = new URLSearchParams(window.location.search);
const stripeIframeFixture = fixtureParams.has('stripe-frame');
const stripeAuthorizationFixture = fixtureParams.has('stripe-authorization');
const restoredReconciliationFixture = fixtureParams.has('restored-reconciliation');
const pendingActionKey = `sway.pendingAction:${gigId}`;

if (restoredReconciliationFixture && !localStorage.getItem(pendingActionKey)) {
  localStorage.setItem(pendingActionKey, JSON.stringify({
    type: 'request',
    gigId,
    clientRequestId: 'restored-client-request',
    idempotencyKey: 'sway:restored-client-request',
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }));
}

function PaymentModalViewportHarness() {
  const [submissionCount, setSubmissionCount] = useState(0);

  return (
    <>
      <output data-sway-payment-submission-count="true" className="sr-only">{submissionCount}</output>
      {stripeIframeFixture ? (
        <button
          type="button"
          data-sway-inject-provider-frame="true"
          className="sr-only"
          onClick={() => {
            const dialog = document.querySelector<HTMLElement>('[data-sway-payment-dialog="true"]');
            if (!dialog || dialog.querySelector('[data-sway-provider-frame-fixture="true"]')) return;
            const frame = document.createElement('iframe');
            frame.dataset.swayProviderFrameFixture = 'true';
            frame.title = 'Secure payment fields';
            frame.src = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html><body><input aria-label="Card number"><button type="button">Provider next</button></body></html>')}`;
            frame.className = 'h-20 w-full rounded border border-white/20';
            dialog.querySelector('[data-sway-payment-actions="true"]')?.prepend(frame);
          }}
        >
          Inject secure payment frame
        </button>
      ) : null}
      <PatronView
        session={session}
        requests={[]}
        performers={[]}
        gigId={gigId}
        onCreateRequest={async (data) => {
          if (stripeAuthorizationFixture && !data.payment_intent_id) {
            throw Object.assign(new Error('Payment authorization required.'), {
              status: 402,
              body: {
                error: 'Payment authorization required.',
                payment_status: 'requires_confirmation',
                client_secret: 'pi_fixture_secret_fixture',
                payment_intent_id: 'pi_fixture'
              }
            });
          }
          setSubmissionCount((count) => count + 1);
          return { success: true };
        }}
        onBoostRequest={async () => ({ success: true })}
        onReconcilePendingAction={async () => (
          restoredReconciliationFixture
            ? { status: 'reconciled', recovery: 'resubmit_original_action' }
            : { status: 'missing' }
        )}
        onReportContent={async () => ({ success: true })}
        onBlockFoundation={async () => ({ success: true })}
        onSupportContact={async () => ({ success: true })}
        onDataDeletionPlaceholder={async () => ({ success: true })}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<PaymentModalViewportHarness />);
