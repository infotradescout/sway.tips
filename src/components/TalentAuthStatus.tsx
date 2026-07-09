/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export function useAuthQueryStatusMessage(messagesByStatus: Record<string, string>) {
  const searchParams = new URLSearchParams(window.location.search);
  const status = searchParams.get('status');
  return status && messagesByStatus[status] ? messagesByStatus[status] : null;
}

type StatusBannerTone = 'amber' | 'emerald' | 'rose';

const TONE_CLASSES: Record<StatusBannerTone, string> = {
  amber: 'border-amber-500/20 bg-amber-500/10 text-amber-100',
  emerald: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100',
  rose: 'border-rose-500/20 bg-rose-500/10 text-rose-100'
};

export function StatusBanner({ tone, message }: { tone: StatusBannerTone; message: string }) {
  return (
    <div className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${TONE_CLASSES[tone]}`}>
      {message}
    </div>
  );
}
