import { useState } from 'react';
import {
  getEffectiveDiscoveryChannel,
  getOfflineFindUs,
  recordOfflineFindUs,
  type DiscoveryChannel
} from '../shells/discoveryAttribution';
import { sendDiscoveryEvent } from '../shells/frictionClient';

const OPTIONS: Array<{ value: DiscoveryChannel; label: string }> = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'google', label: 'Google' },
  { value: 'facebook', label: 'Facebook / Instagram' },
  { value: 'referral', label: 'Referral / friend' },
  { value: 'existing_customer', label: 'Already knew Sway' },
  { value: 'other', label: 'Other' }
];

type Props = {
  routeFamily: string;
  surface: 'public-profile' | 'public-event' | 'public-release' | 'room-entry';
};

/**
 * Optional offline attribution. Never overwrites a stronger first-touch channel.
 */
export default function DiscoveryFindUsPrompt({ routeFamily, surface }: Props) {
  const [saved, setSaved] = useState(() => Boolean(getOfflineFindUs()));
  const [hidden, setHidden] = useState(() => {
    const channel = getEffectiveDiscoveryChannel();
    return channel !== 'direct' && channel !== 'unknown';
  });

  if (hidden || saved) return null;

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-left">
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">How did you find us?</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">Optional. This never replaces a stronger recorded source like a ChatGPT or Google link.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              recordOfflineFindUs(option.value);
              sendDiscoveryEvent('discovery_landing', {
                shell: 'patron',
                surface,
                route_family: routeFamily,
                has_route_context: true,
                has_session_context: false,
                build_commit: 'unknown',
                attribution_channel: getEffectiveDiscoveryChannel(),
                entity_kind: surface === 'room-entry' ? 'live_room' : surface === 'public-event' ? 'event' : surface === 'public-release' ? 'release' : 'performer'
              });
              setSaved(true);
            }}
            className="inline-flex min-h-9 items-center rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[11px] font-bold text-slate-300 transition hover:border-cyan-300/35 hover:text-white"
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setHidden(true)}
          className="inline-flex min-h-9 items-center px-2 text-[11px] font-bold text-slate-500 hover:text-slate-300"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
