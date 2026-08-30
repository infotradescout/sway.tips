import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import PerformerPublicProfileEditor from '../../src/components/PerformerPublicProfileEditor';
import TalentDashboard from '../../src/components/TalentDashboard';
import type { GigSession } from '../../src/types';

const requestedView = new URLSearchParams(window.location.search).get('view');
const view = requestedView === 'roles'
  || requestedView === 'sources'
  || requestedView === 'sources_uploads'
  || requestedView === 'sources_error'
  || requestedView === 'room'
  ? requestedView
  : 'payout';

const inactiveSession: GigSession = {
  status: 'inactive',
  startedAt: null,
  autoCloseoutAt: null,
  closedAt: null,
  talentName: 'Multi-Talent Test',
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
  settlementMode: 'connected_account',
  paymentEnvironment: 'test',
  totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: 'None yet' }
};

const activeSession: GigSession = {
  ...inactiveSession,
  status: 'active',
  startedAt: new Date().toISOString()
};

const performerProfile = {
  performer_id: '33333333-3333-4333-8333-333333333341',
  display_name: 'Multi-Talent Test',
  handle: 'multi-talent-test',
  stage_name: null,
  primary_role: 'creator',
  roles: ['creator', 'dj', 'host'],
  specialties: ['Open format', 'Live hosting'],
  owner_user_id: '44444444-4444-4444-8444-444444444441',
  charges_enabled: false,
  payouts_enabled: false,
  stripe_connected_account_id: null,
  payout_destination_kind: null,
  money_actions_ready: false,
  test_mode_platform_balance_allowed: false
};

if (view === 'sources' || view === 'sources_uploads' || view === 'sources_error' || view === 'room') {
  window.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.pathname === '/api/talent/library/sources') {
      if (view === 'sources_error') return new Response(JSON.stringify({ error: 'Saved sources are temporarily unavailable.' }), { status: 503, headers: { 'content-type': 'application/json' } });
      if (view === 'sources_uploads') return new Response(JSON.stringify({ sources: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        sources: [
          { id: '11111111-1111-4111-8111-111111111111', sourceKey: 'virtualdj-import', sourceLabel: 'VirtualDJ library', syncKeyPreview: 'file-import', connectionStatus: 'active', lastSyncedAt: '2026-08-30T12:00:00.000Z', trackCount: 2 },
          { id: '22222222-2222-4222-8222-222222222222', sourceKey: 'spotify-demo', sourceLabel: 'Spotify: Saturday set', syncKeyPreview: 'spotify-import', connectionStatus: 'active', lastSyncedAt: '2026-08-30T12:30:00.000Z', trackCount: 1 }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/talent/library/tracks') {
      if (view === 'sources_error') return new Response(JSON.stringify({ error: 'Saved music is temporarily unavailable.' }), { status: 503, headers: { 'content-type': 'application/json' } });
      if (view === 'sources_uploads') {
        return new Response(JSON.stringify({
          catalog: { tracks: [{ id: 'catalog-1', title: 'Original Song', artist: 'Multi-Talent Test', album: null, artworkUrl: null, sourceLabel: 'Catalog', sourceKey: 'catalog' }] },
          external: { tracks: [] }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        catalog: { tracks: [] },
        external: { tracks: [
          { id: 'external-1', title: 'Track One', artist: 'Artist A', album: null, artworkUrl: null, sourceLabel: 'VirtualDJ library', sourceKey: 'virtualdj-import' },
          { id: 'external-2', title: 'Track Two', artist: 'Artist B', album: null, artworkUrl: null, sourceLabel: 'VirtualDJ library', sourceKey: 'virtualdj-import' },
          { id: 'external-3', title: 'Track Three', artist: 'Artist C', album: null, artworkUrl: null, sourceLabel: 'Spotify: Saturday set', sourceKey: 'spotify-demo' }
        ] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/payment/config') {
      return new Response(JSON.stringify({ mode: 'test', liveRoomMoneyEnabled: true, testModePlatformBalanceEnabled: false, payoutDestinationCapabilities: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function PayoutHarness() {
  window.history.replaceState({}, '', '/talent/account');
  return (
    <TalentDashboard
      session={inactiveSession}
      requests={[]}
      onStartSession={async () => {}}
      onEndSession={() => {}}
      onCloseout={() => {}}
      onTriage={() => {}}
      onFulfill={() => {}}
      onHide={() => {}}
      onRemove={() => {}}
      activeGigId={null}
      performerProfile={performerProfile}
    />
  );
}

function SourcesHarness() {
  window.history.replaceState({}, '', '/talent/connections');
  return (
    <TalentDashboard
      session={inactiveSession}
      requests={[]}
      onStartSession={async () => {}}
      onEndSession={() => {}}
      onCloseout={() => {}}
      onTriage={() => {}}
      onFulfill={() => {}}
      onHide={() => {}}
      onRemove={() => {}}
      activeGigId={null}
      performerProfile={performerProfile}
    />
  );
}

function RoomHarness() {
  const gigId = '55555555-5555-4555-8555-555555555555';
  window.history.replaceState({}, '', '/talent/gigs');
  return (
    <TalentDashboard
      session={activeSession}
      requests={[]}
      onStartSession={async () => {}}
      onEndSession={() => {}}
      onCloseout={() => {}}
      onTriage={() => {}}
      onFulfill={() => {}}
      onHide={() => {}}
      onRemove={() => {}}
      activeGigId={gigId}
      activeRooms={[{
        gigId,
        performerName: 'Multi-Talent Test',
        talentRole: 'DJ',
        routePath: `/dj/${gigId}`,
        startedAt: activeSession.startedAt,
        requestCount: 0
      }]}
      selectedGigId={gigId}
      performerProfile={performerProfile}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  view === 'roles'
    ? <main className="min-h-screen bg-slate-950 p-3"><PerformerPublicProfileEditor performerHandle="multi-talent-test" /></main>
    : view === 'sources' || view === 'sources_uploads' || view === 'sources_error'
      ? <SourcesHarness />
      : view === 'room'
        ? <RoomHarness />
        : <PayoutHarness />
);
