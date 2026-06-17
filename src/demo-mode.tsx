import type { BackendState, PerformerProfile, RequestItem } from './types';

const demoFixtureSource = 'demo-fixture-harness';
const demoFixtureUrl = '/sway-demo-fixtures.json';

type DemoFixtureRecord = {
  id: string;
  demo: true;
  fixtureSource: typeof demoFixtureSource;
};

type DemoFixturePayload = {
  fixtureKind: 'demo';
  fixtureSource: typeof demoFixtureSource;
  surfaces: {
    profiles: Array<PerformerProfile & DemoFixtureRecord>;
    requests: Array<RequestItem & DemoFixtureRecord>;
    [surface: string]: unknown;
  };
  state: {
    session: BackendState['session'] & DemoFixtureRecord;
  };
};

export function isDemoModeEnabled(): boolean {
  return import.meta.env.VITE_SWAY_DEMO_MODE === 'true' && !import.meta.env.PROD;
}

function hasDemoRecordMarker(record: unknown): record is DemoFixtureRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Partial<DemoFixtureRecord>;
  return candidate.demo === true
    && candidate.fixtureSource === demoFixtureSource
    && typeof candidate.id === 'string'
    && candidate.id.startsWith('demo_');
}

function assertDemoRecords(records: unknown[], surface: string) {
  for (const record of records) {
    if (!hasDemoRecordMarker(record)) {
      throw new Error(`Invalid demo fixture record for ${surface}.`);
    }

    const boosts = (record as Partial<RequestItem>).boosts;
    if (Array.isArray(boosts)) {
      assertDemoRecords(boosts, `${surface}.boosts`);
    }
  }
}

function assertDemoPayload(payload: DemoFixturePayload) {
  if (payload.fixtureKind !== 'demo' || payload.fixtureSource !== demoFixtureSource) {
    throw new Error('Invalid demo fixture payload.');
  }

  if (!hasDemoRecordMarker(payload.state.session)) {
    throw new Error('Invalid demo fixture session.');
  }

  assertDemoRecords(payload.surfaces.profiles, 'profiles');
  assertDemoRecords(payload.surfaces.requests, 'requests');
}

export async function loadDemoBackendState(): Promise<BackendState | null> {
  if (!isDemoModeEnabled()) return null;

  const response = await fetch(demoFixtureUrl);
  if (!response.ok) {
    throw new Error('Demo mode is enabled, but demo fixtures are unavailable.');
  }

  const payload = await response.json() as DemoFixturePayload;
  assertDemoPayload(payload);

  return {
    session: payload.state.session,
    requests: payload.surfaces.requests,
    performers: payload.surfaces.profiles,
    activeGigId: null
  };
}

export function DemoModeBanner({ compact = false }: { compact?: boolean }) {
  if (!isDemoModeEnabled()) return null;

  return (
    <div className={compact ? 'rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-amber-200' : 'border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-center text-[10px] font-bold uppercase tracking-widest text-amber-200'}>
      Demo data
    </div>
  );
}
