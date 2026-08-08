import type { PerformerVisibilityState } from './public-profile';

export const PERFORMER_VISIBILITY_STATES: readonly PerformerVisibilityState[] = [
  'draft',
  'unlisted',
  'public'
];

export function parsePerformerVisibilityState(value: unknown): PerformerVisibilityState | null {
  if (typeof value !== 'string') return null;
  return PERFORMER_VISIBILITY_STATES.includes(value as PerformerVisibilityState)
    ? value as PerformerVisibilityState
    : null;
}
