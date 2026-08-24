import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import PatronView from '../../src/components/PatronView';
import PerformerRoomSetup, {
  type PerformerRoomSetupData
} from '../../src/components/PerformerRoomSetup';
import PublicEventPage from '../../src/components/PublicEventPage';
import type { GigSession, LiveRoomType, RoomRequestMenuItem } from '../../src/types';

const eventId = '22222222-2222-4222-8222-222222222222';
type FixtureRoomType = Exclude<LiveRoomType, 'music'>;

const roomFixtures: Record<FixtureRoomType, {
  gigId: string;
  talentName: string;
  requestMenu: RoomRequestMenuItem[];
}> = {
  comedy: {
    gigId: '11111111-1111-4111-8111-111111111101',
    talentName: 'Casey Crowdwork',
    requestMenu: [
      {
        id: '33333333-3333-4333-8333-333333333331',
        title: "Audience story prompt for the comedian's closing crowdwork segment",
        description: 'Suggest a respectful, specific audience story that gives the comedian enough context to build a thoughtful crowdwork moment without targeting another guest.',
        targetType: 'custom'
      },
      {
        id: '33333333-3333-4333-8333-333333333332',
        title: 'Celebration acknowledgment between comedy sets',
        description: 'Share a birthday, anniversary, or community milestone for the comedy host to consider acknowledging between sets.',
        targetType: 'custom'
      }
    ]
  },
  service: {
    gigId: '11111111-1111-4111-8111-111111111102',
    talentName: 'Jordan Service Desk',
    requestMenu: [
      {
        id: '44444444-4444-4444-8444-444444444441',
        title: 'Large celebration table service request with accessibility details',
        description: 'Tell the service professional what your group needs, including timing, seating, or accessibility context, without including payment-card or other sensitive information.',
        targetType: 'custom'
      },
      {
        id: '44444444-4444-4444-8444-444444444442',
        title: 'Venue information request for a late-arriving guest',
        description: 'Ask a practical question about the venue experience for the service professional to answer when available.',
        targetType: 'custom'
      }
    ]
  },
  general: {
    gigId: '11111111-1111-4111-8111-111111111103',
    talentName: 'Morgan Community Host',
    requestMenu: [
      {
        id: '55555555-5555-4555-8555-555555555551',
        title: 'Community sponsor acknowledgment for the neighborhood fundraiser finale',
        description: 'Submit a concise, respectful acknowledgment for the professional host to consider during the live community program.',
        targetType: 'custom'
      },
      {
        id: '55555555-5555-4555-8555-555555555552',
        title: 'Audience question for the closing professional discussion',
        description: 'Suggest a relevant audience question with enough context for the professional to decide whether it fits the closing discussion.',
        targetType: 'custom'
      }
    ]
  }
};

function resolveFixtureRoomType(value: string | null): FixtureRoomType {
  return value === 'service' || value === 'general' ? value : 'comedy';
}

function fixtureSetup(roomType: FixtureRoomType): PerformerRoomSetupData {
  const fixture = roomFixtures[roomType];
  return {
    gig_id: fixture.gigId,
    talentName: fixture.talentName,
    talentRole: 'Performer',
    roomType,
    requestMenu: fixture.requestMenu.map((item) => ({ ...item })),
    linkedEventId: eventId,
    feeType: 'talent',
    minimumTip: 5,
    paymentsEnabled: false,
    searchScope: 'library'
  };
}

function sessionFromSetup(setup: PerformerRoomSetupData): GigSession {
  const startedAt = new Date().toISOString();
  return {
    status: 'active',
    startedAt,
    autoCloseoutAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    closedAt: null,
    talentName: setup.talentName,
    talentRole: setup.roomType === 'service' ? 'Bartender' : setup.talentRole,
    roomType: setup.roomType,
    requestMenu: setup.requestMenu,
    linkedEventId: setup.linkedEventId,
    linkedEvent: setup.linkedEventId ? {
      id: setup.linkedEventId,
      title: 'Friday Community Showcase with Crowdwork, Service Stories, and Local Hosts',
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      eventPath: `/e/${setup.linkedEventId}`,
      attendanceMode: 'external_ticket'
    } : null,
    feeType: setup.feeType,
    minimumTip: setup.minimumTip,
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
    searchScope: setup.searchScope,
    paymentsEnabled: setup.paymentsEnabled,
    tipsEnabled: false,
    settlementMode: 'unavailable',
    paymentEnvironment: 'unavailable',
    totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: 'None yet' }
  };
}

function GeneralizedLiveRoomHarness() {
  const fixtureRoomType = resolveFixtureRoomType(new URLSearchParams(window.location.search).get('roomType'));
  const shouldStartWithFixture = new URLSearchParams(window.location.search).get('started') === 'true';
  const [setup, setSetup] = useState<PerformerRoomSetupData | null>(() => (
    shouldStartWithFixture ? fixtureSetup(fixtureRoomType) : null
  ));
  const [requestProof, setRequestProof] = useState<Record<string, unknown> | null>(null);
  const [reportProof, setReportProof] = useState<Record<string, unknown> | null>(null);
  const [showEvent, setShowEvent] = useState(false);

  if (showEvent) {
    return <PublicEventPage eventId={eventId} />;
  }

  if (!setup) {
    return (
      <main className="min-h-screen bg-slate-950 px-3 py-4">
        <PerformerRoomSetup
          performerName="Casey Crowdwork"
          talentRole="Performer"
          performerEmailVerified
          payoutReady={false}
          paymentMode="unavailable"
          onStartSession={async (data) => setSetup({
            ...data,
            gig_id: data.roomType === 'music'
              ? data.gig_id
              : roomFixtures[data.roomType].gigId
          })}
        />
      </main>
    );
  }

  const session = sessionFromSetup(setup);
  return (
    <>
      <div className="fixed right-2 top-2 z-[100] flex gap-2">
        <button
          type="button"
          data-sway-open-event-proof="true"
          onClick={() => setShowEvent(true)}
          className="min-h-11 min-w-11 rounded-full bg-cyan-400 px-3 text-xs font-black text-slate-950"
        >
          View event proof
        </button>
      </div>
      <output data-sway-room-setup-proof="true" className="sr-only">{JSON.stringify(setup)}</output>
      <output data-sway-patron-request-proof="true" className="sr-only">{requestProof ? JSON.stringify(requestProof) : ''}</output>
      <output data-sway-menu-report-proof="true" className="sr-only">{reportProof ? JSON.stringify(reportProof) : ''}</output>
      <PatronView
        session={session}
        requests={[]}
        performers={[]}
        gigId={setup.gig_id}
        onCreateRequest={async (data) => {
          setRequestProof(data);
          return { success: true };
        }}
        onBoostRequest={async () => ({ success: true })}
        onReconcilePendingAction={async () => ({ status: 'not_found' })}
        onReportContent={async () => ({ success: true })}
        onReportMenuItem={async (gigId, menuItemId, reason, details) => {
          setReportProof({ gig_id: gigId, menu_item_id: menuItemId, reason, details });
          return { moderation_action: 'room_menu_report_submitted' };
        }}
        onBlockFoundation={async () => ({ success: true })}
        onSupportContact={async () => ({ success: true })}
        onDataDeletionPlaceholder={async () => ({ success: true })}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<GeneralizedLiveRoomHarness />);
