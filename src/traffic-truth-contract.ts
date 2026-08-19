export const SWAY_INTERNAL_QA_JOURNEY_PREFIX = '00000000-' as const;
export const SWAY_TRAFFIC_TRUTH_QA_QUERY_KEY = 'sway_traffic' as const;
export const SWAY_TRAFFIC_TRUTH_QA_QUERY_VALUE = 'qa' as const;
export const SWAY_TRAFFIC_TRUTH_LIVE_QUERY_VALUE = 'live' as const;
export const SWAY_TRAFFIC_TRUTH_QA_COOKIE = 'sway_traffic_truth' as const;

export function isInternalQaJourneyId(value: unknown): value is string {
  return typeof value === 'string'
    && value.toLowerCase().startsWith(SWAY_INTERNAL_QA_JOURNEY_PREFIX);
}

export function namespaceInternalQaJourneyId(journeyId: string) {
  return `${SWAY_INTERNAL_QA_JOURNEY_PREFIX}${journeyId.slice(SWAY_INTERNAL_QA_JOURNEY_PREFIX.length)}`;
}
