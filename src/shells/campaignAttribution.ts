const CAMPAIGN_CODE_STORAGE_KEY = 'sway.campaignCode';

/**
 * Sway-issued campaign links carry ?camp=<code>. Captured on entry (room or performer
 * profile route), persisted to sessionStorage for the rest of the tab session so it
 * survives navigating from a profile page into a room, and verified server-side before
 * it ever affects a fee -- this is a hint, not an authority
 * (resolveCampaignAttribution in business-store.ts is the real gate).
 *
 * Shared by every patron-facing entry surface so the storage key and parsing logic
 * have exactly one definition -- see src/components/PatronView.tsx and
 * src/components/PerformerShareKit.tsx for the precedent of components importing
 * shared shell utilities (frictionClient.ts) the same way.
 */
export function captureCampaignCode(): string | null {
  if (typeof window === 'undefined') return null;
  const fromQuery = new URLSearchParams(window.location.search).get('camp');
  if (fromQuery) {
    window.sessionStorage.setItem(CAMPAIGN_CODE_STORAGE_KEY, fromQuery);
    return fromQuery;
  }
  return window.sessionStorage.getItem(CAMPAIGN_CODE_STORAGE_KEY);
}
