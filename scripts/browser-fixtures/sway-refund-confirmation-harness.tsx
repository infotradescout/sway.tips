import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import TalentDashboard from '../../src/components/TalentDashboard';
import type { GigSession, RequestItem } from '../../src/types';

const gigId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

const session: GigSession = {
  status: 'active',
  startedAt: new Date().toISOString(),
  autoCloseoutAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  closedAt: null,
  talentName: 'Refund Test Performer',
  talentRole: 'DJ',
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
  totals: { totalTips: 5, accumulatedFees: 1, totalCount: 1, topRequest: 'Shoutout' }
};

const approvedRequest: RequestItem = {
  id: requestId,
  type: 'request',
  targetType: 'custom',
  title: 'Shoutout',
  subtitle: 'Quick crowd shoutout',
  senderName: 'Refund QA',
  amount: 5,
  holdAmount: 5,
  platformFee: 1,
  sponsorCount: 1,
  status: 'approved',
  shadowBanned: false,
  createdAt: new Date().toISOString(),
  paymentStatus: 'captured',
  boosts: []
};

function RefundConfirmationHarness() {
  const [requests, setRequests] = useState<RequestItem[]>([approvedRequest]);
  const [submissionCount, setSubmissionCount] = useState(0);

  const removeRequest = async (id: string) => {
    setSubmissionCount((count) => count + 1);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    setRequests((current) => current.filter((request) => request.id !== id));
  };

  return (
    <>
      <output data-sway-remove-submission-count="true" className="sr-only">{submissionCount}</output>
      <TalentDashboard
        session={session}
        requests={requests}
        onStartSession={async () => {}}
        onEndSession={() => {}}
        onCloseout={() => {}}
        onTriage={() => {}}
        onFulfill={() => {}}
        onHide={() => {}}
        onRemove={removeRequest}
        activeGigId={gigId}
        activeRooms={[{
          gigId,
          performerName: '@refund-test-performer',
          talentRole: 'DJ',
          routePath: `/g/${gigId}`,
          startedAt: session.startedAt,
          requestCount: 1
        }]}
        selectedGigId={gigId}
        performerProfile={{
          performer_id: '33333333-3333-4333-8333-333333333333',
          display_name: 'Refund Test Performer',
          handle: 'refund-test-performer',
          stage_name: 'Refund Test Performer',
          primary_role: 'DJ',
          specialties: ['DJ'],
          owner_user_id: '44444444-4444-4444-8444-444444444444',
          charges_enabled: true,
          payouts_enabled: false,
          money_actions_ready: true,
          test_mode_platform_balance_allowed: true
        }}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<RefundConfirmationHarness />);
