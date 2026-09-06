import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import VictoryScreen from '../../src/components/VictoryScreen';
import { emptySession } from '../../src/shells/shared';
import type { RequestItem } from '../../src/types';
import '../../src/index.css';

// Synthetic accounts and records only. This fixture does not contact an API.
function Harness() {
  const [next, setNext] = useState(false);
  const [starts, setStarts] = useState(0);
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'live';
  const requestedCount = Number(params.get('count') || '1001');
  const count = Math.max(0, Math.min(1001, Number.isFinite(requestedCount) ? requestedCount : 0));
  const requests: RequestItem[] = next ? [] : Array.from({ length: count }, (_, index) => ({
    id: `synthetic-${index}`, type: index === 1 ? 'tip' : 'request', targetType: 'music',
    title: index === count - 1 ? `Final request ${'x'.repeat(160)}` : `Request ${index}`,
    subtitle: `Artist ${index}`, senderName: 'PRIVATE_CUSTOMER_NOT_FOR_SHARING',
    message: 'PRIVATE_MESSAGE_NOT_FOR_SHARING', amount: index === 2 ? 5 : 0, holdAmount: 0,
    platformFee: 0, sponsorCount: 9, status: index === 1 || index % 4 === 0 ? 'fulfilled' : index % 4 === 1 ? 'approved' : index % 4 === 2 ? 'hold' : 'denied',
    paymentStatus: index === 2 ? 'authorized' : undefined,
    shadowBanned: false, hidden: index === 7, removed: index === 8,
    createdAt: '2026-09-06T00:00:00Z', boosts: []
  }));
  const session = {
    ...emptySession, status: 'closed' as const,
    talentName: next ? '@next-night' : `@fixture-${'n'.repeat(50)}`,
    talentRole: 'Performer' as const, startedAt: next ? '2026-09-06T01:00:00Z' : '2026-09-05T22:00:00Z',
    closedAt: next ? '2026-09-06T02:00:00Z' : '2026-09-06T00:00:00Z',
    paymentEnvironment: mode === 'test' ? 'test' as const : mode === 'unavailable' ? 'unavailable' as const : 'live' as const,
    settlementMode: mode === 'conflict' ? 'platform_test_balance' as const : mode === 'unavailable' ? 'unavailable' as const : 'platform_balance' as const,
    totals: { totalTips: mode === 'invalid' ? Number.NaN : mode === 'unavailable' ? 0 : 1234567.89, accumulatedFees: 1.25, totalCount: 98765, topRequest: `Long title ${'z'.repeat(150)}` }
  };
  return <><button type="button" onClick={() => setNext(true)}>Switch fixture night</button><output hidden data-testid="fixture-starts">{starts}</output><VictoryScreen session={session} requests={requests} onRestart={() => setStarts(value => value + 1)} /></>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
