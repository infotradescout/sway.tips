/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Trash2, 
  Check, 
  X, 
  Coins, 
  Clock, 
  AlertTriangle, 
  TrendingUp, 
  Sparkles, 
  Award, 
  Users, 
  Settings, 
  Flame, 
  Radio, 
  Search,
  Badge,
  Plus,
  Sliders,
  ToggleLeft,
  ToggleRight,
  Hourglass,
  Upload,
  CreditCard,
  Link as LinkIcon,
  Music2,
  ShieldCheck,
  Keyboard,
  Home,
  UserRound
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ActiveRoomSummary, GigSession, RequestItem } from '../types';
import PerformerRoomControls from './PerformerRoomControls';
import PerformerAudienceScreen from './PerformerAudienceScreen';
import PerformerAccountHome from './PerformerAccountHome';
import PerformerRoomShare, { copyRoomLink, resolveLiveRoomLink } from './PerformerRoomShare';
import PerformerRoomSetup, { PerformerRoomSetupData } from './PerformerRoomSetup';
import PerformerPublicProfileEditor from './PerformerPublicProfileEditor';

interface TalentDashboardProps {
  session: GigSession;
  requests: RequestItem[];
  onStartSession: (data: PerformerRoomSetupData) => void;
  onEndSession: () => void;
  onCloseout: () => void;
  onTriage: (requestId: string, action: 'approve' | 'deny') => void;
  onFulfill: (requestId: string) => void;
  onHide: (requestId: string) => void;
  onRemove: (requestId: string) => void;
  activeGigId: string | null;
  activeRooms?: ActiveRoomSummary[];
  selectedGigId?: string | null;
  onSelectGigId?: (gigId: string | null) => void;
  previewMode?: boolean;
  performerProfile?: {
    performer_id: string;
    display_name: string;
    handle: string | null;
    owner_user_id: string;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    stripe_connected_account_id?: string | null;
  } | null;
  performerEmailVerified?: boolean;
}

type InactivePerformerWorkspace = 'home' | 'room' | 'library' | 'profile' | 'account';

const INACTIVE_PERFORMER_NAVIGATION = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'room', label: 'Live', icon: Radio },
  { id: 'library', label: 'Library', icon: Music2 },
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'account', label: 'Account', icon: Settings }
] as const;

type MusicSourceCapability = {
  providerKey: 'local_library' | 'spotify' | 'soundcloud';
  displayName: string;
  sourceMode: 'sync_key' | 'app_catalog' | 'oauth_provider';
  authRequirement: 'none' | 'sync_key' | 'app_credentials' | 'oauth';
  connectionStatus: 'available' | 'configured' | 'not_configured' | 'not_connected';
  capabilities: {
    searchMetadata: boolean;
    importLibrary: boolean;
    openExternal: boolean;
    playInSway: boolean;
    requiresTrackAvailabilityCheck: boolean;
  };
  performerActionLabel: string;
  audienceClaim: string;
  riskNote: string;
};

const DEFAULT_MUSIC_SOURCE_CAPABILITIES: MusicSourceCapability[] = [
  {
    providerKey: 'local_library',
    displayName: 'Synced Library',
    sourceMode: 'sync_key',
    authRequirement: 'sync_key',
    connectionStatus: 'available',
    capabilities: {
      searchMetadata: true,
      importLibrary: true,
      openExternal: true,
      playInSway: false,
      requiresTrackAvailabilityCheck: false
    },
    performerActionLabel: 'Matched in library',
    audienceClaim: 'Request from the performer library',
    riskNote: 'Metadata availability only. The performer still plays audio from their existing setup.'
  },
  {
    providerKey: 'spotify',
    displayName: 'Spotify',
    sourceMode: 'app_catalog',
    authRequirement: 'app_credentials',
    connectionStatus: 'not_configured',
    capabilities: {
      searchMetadata: false,
      importLibrary: false,
      openExternal: true,
      playInSway: false,
      requiresTrackAvailabilityCheck: true
    },
    performerActionLabel: 'Open in Spotify',
    audienceClaim: 'Spotify metadata match',
    riskNote: 'Spotify is metadata/search only for Sway. Sway must not claim venue playback from Spotify.'
  },
  {
    providerKey: 'soundcloud',
    displayName: 'SoundCloud',
    sourceMode: 'oauth_provider',
    authRequirement: 'oauth',
    connectionStatus: 'not_connected',
    capabilities: {
      searchMetadata: false,
      importLibrary: false,
      openExternal: true,
      playInSway: false,
      requiresTrackAvailabilityCheck: true
    },
    performerActionLabel: 'Connect SoundCloud',
    audienceClaim: 'SoundCloud account link required',
    riskNote: 'SoundCloud access depends on OAuth, track permissions, attribution, and per-track availability.'
  },
];

type HardwareActionId =
  | 'toggle_requests'
  | 'fulfill_top'
  | 'hide_top'
  | 'approve_pending'
  | 'veto_pending'
  | 'open_top_source';

type HardwareBinding = {
  keyboard: string | null;
  midi: string | null;
};

type HardwareBindingMap = Record<HardwareActionId, HardwareBinding>;

const HARDWARE_BINDING_STORAGE_KEY = 'sway.performer.hardwareBindings.v1';

const HARDWARE_ACTIONS: Array<{ id: HardwareActionId; label: string }> = [
  { id: 'toggle_requests', label: 'Pause / Resume' },
  { id: 'fulfill_top', label: 'Play / Clear Top' },
  { id: 'hide_top', label: 'Hide Top' },
  { id: 'approve_pending', label: 'Approve Pending' },
  { id: 'veto_pending', label: 'Veto Pending' },
  { id: 'open_top_source', label: 'Open Source' }
];

const DEFAULT_HARDWARE_BINDINGS: HardwareBindingMap = {
  toggle_requests: { keyboard: 'Space', midi: null },
  fulfill_top: { keyboard: 'Enter', midi: null },
  hide_top: { keyboard: 'Backspace', midi: null },
  approve_pending: { keyboard: 'KeyA', midi: null },
  veto_pending: { keyboard: 'KeyV', midi: null },
  open_top_source: { keyboard: 'KeyO', midi: null }
};

const BRIDGE_PRESET_ACTIONS = [
  ['toggle-requests', 'Pause / Resume', '/action/toggle-requests', '#22c55e'],
  ['fulfill-top', 'Clear Top', '/action/fulfill-top', '#06b6d4'],
  ['hide-top', 'Hide Top', '/action/hide-top', '#f59e0b'],
  ['open-top-source', 'Open Source', '/action/open-top-source', '#10b981'],
  ['search-top-spotify', 'Spotify Search', '/action/search-top-spotify', '#1db954'],
  ['search-top-soundcloud', 'SoundCloud Search', '/action/search-top-soundcloud', '#ff5500'],
  ['search-top-youtube', 'YouTube Search', '/action/search-top-youtube', '#ef4444'],
  ['approve-pending', 'Approve Pending', '/action/approve-pending', '#84cc16'],
  ['veto-pending', 'Veto Pending', '/action/veto-pending', '#f43f5e']
] as const;

function createDefaultHardwareBindings(): HardwareBindingMap {
  return Object.fromEntries(
    HARDWARE_ACTIONS.map((action) => [action.id, { ...DEFAULT_HARDWARE_BINDINGS[action.id] }])
  ) as HardwareBindingMap;
}

function normalizeHardwareBindings(input: unknown): HardwareBindingMap {
  const fallback = createDefaultHardwareBindings();
  if (!input || typeof input !== 'object') return fallback;
  const raw = input as Partial<Record<HardwareActionId, Partial<HardwareBinding>>>;

  for (const action of HARDWARE_ACTIONS) {
    const item = raw[action.id];
    fallback[action.id] = {
      keyboard: typeof item?.keyboard === 'string' && item.keyboard ? item.keyboard : null,
      midi: typeof item?.midi === 'string' && item.midi ? item.midi : null
    };
  }

  return fallback;
}

function loadHardwareBindings(): HardwareBindingMap {
  if (typeof window === 'undefined') return createDefaultHardwareBindings();
  try {
    return normalizeHardwareBindings(JSON.parse(window.localStorage.getItem(HARDWARE_BINDING_STORAGE_KEY) || 'null'));
  } catch {
    return createDefaultHardwareBindings();
  }
}

function hardwareInputLabel(value: string | null) {
  if (!value) return 'Unassigned';
  if (value.startsWith('midi:')) {
    const [, status, channel, note] = value.split(':');
    return `MIDI ${status} ch ${Number(channel) + 1} #${note}`;
  }
  return value
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('Space', 'Space')
    .replace('Backspace', 'Backspace')
    .replace('Enter', 'Enter');
}

function resolveMidiBinding(data: Uint8Array) {
  const [statusByte, note, velocity] = data;
  if (typeof statusByte !== 'number' || typeof note !== 'number') return null;
  const status = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  if (status === 0x90 && velocity > 0) return `midi:note_on:${channel}:${note}`;
  if (status === 0xb0) return `midi:control_change:${channel}:${note}`;
  return null;
}

function buildDashboardBridgePreset({
  gigId,
  bridgeToken,
  swayUrl,
  bridgeCommand
}: {
  gigId: string | null;
  bridgeToken: string;
  swayUrl: string;
  bridgeCommand: string;
}) {
  const actionsBaseUrl = `${swayUrl.replace(/\/+$/, '')}/api/talent/control-bridge/action`;
  const actions = BRIDGE_PRESET_ACTIONS.map(([id, label, path, color], index) => {
    const action = path.replace(/^\/action\//, '');
    return {
      id,
      label,
      slot: index + 1,
      method: 'POST',
      url: `${actionsBaseUrl}/${action}`,
      color
    };
  });

  return {
    schema: 'sway-dashboard-control-bridge-preset.v1',
    generatedAt: new Date().toISOString(),
    gigId,
    transport: 'direct-cloud',
    auth: {
      header: 'Authorization',
      value: `Bearer ${bridgeToken}`,
      note: 'This token is short-lived (2 hours). Reissue and re-download the preset once it expires.'
    },
    localBridgeFallback: {
      launchCommand: bridgeCommand,
      note: 'Only needed for MIDI/foot-pedal hardware, or tools (like raw Stream Deck without Companion) that cannot send a custom Authorization header.'
    },
    actions,
    companion: {
      module: 'Generic HTTP Request',
      importMode: 'create one POST button per action, using the url/headers/body below',
      buttons: actions.map((action) => ({
        page: 1,
        row: Math.floor((action.slot - 1) / 4) + 1,
        column: ((action.slot - 1) % 4) + 1,
        text: action.label,
        request: {
          method: action.method,
          url: action.url,
          headers: { Authorization: `Bearer ${bridgeToken}` },
          body: { gig_id: gigId }
        },
        color: action.color
      }))
    },
    streamDeck: {
      importMode: 'Native Stream Deck actions cannot send custom headers -- put Companion in front of Stream Deck, or use localBridgeFallback.launchCommand instead.',
      buttons: actions.map((action) => ({
        slot: action.slot,
        title: action.label,
        method: action.method,
        url: action.url,
        color: action.color
      }))
    }
  };
}

function downloadJsonFile(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}

function CompactRequestPanel({
  title,
  empty,
  overflowCount,
  requests,
  renderActions,
  paymentsEnabled = true
}: {
  title: string;
  empty: string;
  overflowCount: number;
  requests: RequestItem[];
  renderActions: (request: RequestItem) => React.ReactNode;
  paymentsEnabled?: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-display text-xs font-black uppercase tracking-widest text-white">{title}</h3>
        <span className="rounded-full border border-white/10 bg-slate-950 px-2 py-1 text-[10px] font-black text-slate-300">
          {requests.length + overflowCount}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-2 overflow-hidden">
        {requests.length === 0 ? (
          <div className="flex h-full min-h-24 items-center justify-center rounded-xl border border-dashed border-white/10 bg-slate-950/60 px-3 text-center text-xs font-bold text-slate-500">
            {empty}
          </div>
        ) : (
          requests.map((request) => (
            <article key={request.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-white">{request.title}</p>
                <p className="truncate text-[11px] font-semibold text-slate-400 max-[359px]:hidden">{request.subtitle || request.senderName}</p>
                <div className="mt-1 flex items-center gap-2 text-[10px] font-mono font-black text-cyan-300">
                  {paymentsEnabled && (
                    <>
                      <span>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(request.amount)}</span>
                      <span className="text-slate-600">/</span>
                    </>
                  )}
                  <span className="truncate text-slate-400">{request.senderName}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1 [&>button]:flex [&>button]:h-9 [&>button]:w-9 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-lg [&>button]:font-black min-[360px]:[&>button]:h-10 min-[360px]:[&>button]:w-10">
                {renderActions(request)}
              </div>
            </article>
          ))
        )}
      </div>
      {overflowCount > 0 ? (
        <p className="mt-2 truncate text-center text-[10px] font-bold text-slate-500">
          {overflowCount} more visible after clearing the top items.
        </p>
      ) : null}
    </section>
  );
}

function MusicSourcesPanel({
  providers,
  linkedSourceCount,
  syncedTrackCount,
  loading,
  loadError,
  spotifyPlaylistUrl,
  spotifyImportStatus,
  spotifyImportMessage,
  onSpotifyPlaylistUrlChange,
  onSpotifyPlaylistImport
}: {
  providers: MusicSourceCapability[];
  linkedSourceCount: number;
  syncedTrackCount: number;
  loading: boolean;
  loadError: string | null;
  spotifyPlaylistUrl: string;
  spotifyImportStatus: 'idle' | 'submitting' | 'success' | 'error';
  spotifyImportMessage: string | null;
  onSpotifyPlaylistUrlChange: (value: string) => void;
  onSpotifyPlaylistImport: (event: React.FormEvent) => void;
}) {
  const connectionTone = (status: MusicSourceCapability['connectionStatus']) => {
    if (status === 'available' || status === 'configured') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    if (status === 'not_configured') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    return 'border-white/10 bg-slate-950 text-slate-300';
  };

  const sourceIcon = (providerKey: MusicSourceCapability['providerKey']) => {
    if (providerKey === 'local_library') return <ShieldCheck className="h-4 w-4" />;
    return <LinkIcon className="h-4 w-4" />;
  };

  return (
    <section
      data-sway-music-sources-panel="true"
      className="max-w-3xl mx-auto rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-lg"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-display text-xs font-mono font-bold uppercase tracking-wider text-cyan-300">Music Sources</h4>
          <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-slate-400">
            Connect the performer music world to Sway without pretending every provider can play audio here.
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-right">
          <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Synced tracks</p>
          <p className="mt-0.5 font-mono text-sm font-black text-white">{syncedTrackCount}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {providers.map((provider) => {
          const isLocal = provider.providerKey === 'local_library';
          const liveStatus = isLocal && linkedSourceCount > 0 ? 'available' : provider.connectionStatus;
          const statusCopy = isLocal && linkedSourceCount > 0
            ? `${linkedSourceCount} linked source${linkedSourceCount === 1 ? '' : 's'}`
            : liveStatus.replace(/_/g, ' ');

          return (
            <div key={provider.providerKey} className="rounded-xl border border-white/10 bg-slate-950 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
                    {sourceIcon(provider.providerKey)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-white">{provider.displayName}</p>
                    <p className="mt-0.5 truncate text-[10px] font-mono uppercase tracking-widest text-slate-500">
                      {provider.sourceMode.replace(/_/g, ' ')}
                    </p>
                  </div>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${connectionTone(liveStatus)}`}>
                  {statusCopy}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {provider.capabilities.searchMetadata && (
                  <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[9px] font-bold text-cyan-200">Metadata</span>
                )}
                {provider.capabilities.importLibrary && (
                  <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[9px] font-bold text-emerald-200">Library sync</span>
                )}
                {provider.capabilities.openExternal && (
                  <span className="rounded-full border border-fuchsia-500/20 bg-fuchsia-500/10 px-2 py-1 text-[9px] font-bold text-fuchsia-200">Open source</span>
                )}
                <span className={`rounded-full border px-2 py-1 text-[9px] font-bold ${
                  provider.capabilities.playInSway
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                }`}>
                  {provider.capabilities.playInSway ? 'Playable in Sway' : 'No Sway playback'}
                </span>
              </div>

              <p className="mt-3 text-xs font-bold text-white">{provider.performerActionLabel}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{provider.riskNote}</p>
            </div>
          );
        })}
      </div>

      {loading ? (
        <p className="mt-3 text-[10px] font-mono uppercase tracking-widest text-slate-500">Refreshing source capabilities...</p>
      ) : loadError ? (
        <p className="mt-3 text-[10px] text-amber-300">{loadError}</p>
      ) : null}

      <form
        data-sway-spotify-playlist-import="true"
        className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3"
        onSubmit={onSpotifyPlaylistImport}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-300">Spotify playlist import</p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              Import track metadata into My Library. Sway stores requestable songs and opens Spotify externally.
            </p>
          </div>
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-amber-200">
            Metadata only
          </span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <input
            type="text"
            value={spotifyPlaylistUrl}
            onChange={(event) => onSpotifyPlaylistUrlChange(event.target.value)}
            placeholder="https://open.spotify.com/playlist/..."
            className="min-h-11 rounded-xl border border-white/10 bg-slate-950 px-3 py-3 text-sm font-semibold text-white outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            disabled={spotifyImportStatus === 'submitting' || !spotifyPlaylistUrl.trim()}
            className="min-h-11 rounded-xl bg-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-wide text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {spotifyImportStatus === 'submitting' ? 'Importing...' : 'Import'}
          </button>
        </div>
        {spotifyImportMessage ? (
          <p className={`mt-2 text-[10px] ${spotifyImportStatus === 'error' ? 'text-rose-300' : 'text-emerald-200'}`}>
            {spotifyImportMessage}
          </p>
        ) : null}
      </form>
    </section>
  );
}

type RequestLibraryTrack = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  sourceLabel: string;
  sourceKey: string;
};

function RequestLibraryWorkspace({
  externalTracks,
  loading,
  error,
  spotifyPlaylistUrl,
  spotifyImportStatus,
  spotifyImportMessage,
  onSpotifyPlaylistUrlChange,
  onSpotifyPlaylistImport,
  onOpenAdvanced
}: {
  externalTracks: RequestLibraryTrack[];
  loading: boolean;
  error: string | null;
  spotifyPlaylistUrl: string;
  spotifyImportStatus: 'idle' | 'submitting' | 'success' | 'error';
  spotifyImportMessage: string | null;
  onSpotifyPlaylistUrlChange: (value: string) => void;
  onSpotifyPlaylistImport: (event: React.FormEvent) => void;
  onOpenAdvanced: () => void;
}) {
  const totalTracks = externalTracks.length;

  return (
    <section data-sway-library-workspace="true" className="mx-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Library</p>
          <h2 className="mt-1 font-display text-xl font-black uppercase tracking-wide text-white">Music people can request</h2>
          <p className="mt-1 text-xs text-slate-400">Imported playlists and synced DJ-library tracks appear here.</p>
        </div>
        <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-black text-cyan-100">{totalTracks} tracks</span>
      </div>

      <div className="mt-5" aria-label="Library sources">
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
          <div className="flex items-center justify-between gap-3"><p className="font-black text-white">External request music</p><span className="text-sm font-black text-cyan-200">{externalTracks.length}</span></div>
          <p className="mt-1 text-xs text-slate-400">Potentially copyrighted music played from Spotify, DJ software, or another external source.</p>
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {loading ? <p className="text-sm text-slate-400">Loading your music…</p> : null}
        {error ? <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-100">{error}</p> : null}
        {!loading && !error && totalTracks === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 bg-slate-950/60 p-6 text-center">
            <p className="font-black text-white">Your request library is empty</p>
            <p className="mt-2 text-sm text-slate-400">Import a playlist below or connect an existing DJ-library source.</p>
          </div>
        ) : null}
        {externalTracks.length > 0 ? <div className="pt-3"><p className="mb-1 text-[10px] font-black uppercase tracking-[0.22em] text-cyan-300">External request music</p><p className="mb-2 text-xs text-slate-500">Open or play these tracks from their external source.</p>{externalTracks.slice(0, 30).map((track) => (
          <div key={track.id} className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-black text-white">{track.title}</p><p className="truncate text-xs text-slate-400">{track.artist}{track.album ? ` · ${track.album}` : ''}</p></div><span className="shrink-0 rounded-full border border-cyan-500/20 px-2 py-1 text-[10px] font-bold text-cyan-200">{track.sourceLabel}</span></div>
        ))}</div> : null}
      </div>

      <details className="mt-5 rounded-xl border border-white/10 bg-slate-950/60 p-4">
        <summary className="cursor-pointer list-none text-sm font-black text-white">Import a Spotify playlist</summary>
        <form className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={onSpotifyPlaylistImport}>
          <input type="text" value={spotifyPlaylistUrl} onChange={(event) => onSpotifyPlaylistUrlChange(event.target.value)} placeholder="Paste a Spotify playlist link" className="min-h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white" />
          <button type="submit" disabled={spotifyImportStatus === 'submitting' || !spotifyPlaylistUrl.trim()} className="min-h-11 rounded-xl bg-emerald-500 px-4 text-xs font-black text-slate-950 disabled:opacity-50">{spotifyImportStatus === 'submitting' ? 'Importing…' : 'Import playlist'}</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">Imports the song list for requests. Playback remains in your normal music setup.</p>
        {spotifyImportMessage ? <p className={`mt-2 text-xs ${spotifyImportStatus === 'error' ? 'text-rose-300' : 'text-emerald-200'}`}>{spotifyImportMessage}</p> : null}
      </details>

      <button type="button" onClick={onOpenAdvanced} className="mt-4 text-xs font-bold text-slate-400 underline decoration-white/20 underline-offset-4">Advanced library connections</button>
    </section>
  );
}

function SpotifyOpenLink({ request }: { request: RequestItem }) {
  if (!request.spotifyUrl) return null;

  return (
    <a
      href={request.spotifyUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-xs font-mono font-bold text-emerald-200 transition-all hover:border-emerald-400 hover:text-white"
      title="Open this track in Spotify"
    >
      <LinkIcon className="h-3.5 w-3.5" />
      Spotify
    </a>
  );
}

function HardwareMappingPanel({
  bindings,
  learnTarget,
  midiStatus,
  bridgeCommand,
  bridgeTokenStatus,
  bridgeTokenMessage,
  onLearn,
  onClear,
  onIssueBridgeToken,
  onDownloadBridgePreset
}: {
  bindings: HardwareBindingMap;
  learnTarget: HardwareActionId | null;
  midiStatus: 'idle' | 'midi-ready' | 'midi-unavailable' | 'midi-denied';
  bridgeCommand: string | null;
  bridgeTokenStatus: 'idle' | 'submitting' | 'success' | 'error';
  bridgeTokenMessage: string | null;
  onLearn: (actionId: HardwareActionId) => void;
  onClear: (actionId: HardwareActionId, kind: keyof HardwareBinding) => void;
  onIssueBridgeToken: () => void;
  onDownloadBridgePreset: () => void;
}) {
  const midiLabel = midiStatus === 'midi-ready'
    ? 'MIDI ready'
    : midiStatus === 'midi-denied'
      ? 'MIDI blocked'
      : midiStatus === 'midi-unavailable'
        ? 'Keys only'
        : 'Listening';

  return (
    <section
      data-sway-hardware-mapping-panel="true"
      className="rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-display text-xs font-mono font-bold uppercase tracking-wider text-cyan-400">Advanced key controls</h4>
          <p className="mt-1 truncate text-[10px] text-slate-500">{midiLabel}</p>
        </div>
        <Keyboard className="h-5 w-5 shrink-0 text-cyan-300" />
      </div>
      <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-cyan-200">Local bridge token</p>
            <p className="mt-1 truncate text-[10px] text-slate-400">
              {bridgeTokenMessage ?? 'Create a short-lived token for Stream Deck, Companion, or scripts.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onIssueBridgeToken}
            disabled={bridgeTokenStatus === 'submitting'}
            className="shrink-0 rounded-lg bg-cyan-500 px-3 py-2 text-[10px] font-black uppercase text-slate-950 disabled:opacity-50"
          >
            {bridgeTokenStatus === 'submitting' ? 'Creating' : 'Create'}
          </button>
        </div>
        {bridgeCommand ? (
          <div className="mt-3 space-y-2">
            <pre className="max-h-28 overflow-hidden whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-cyan-100">
              {bridgeCommand}
            </pre>
            <button
              type="button"
              onClick={onDownloadBridgePreset}
              data-sway-control-bridge-preset-download="true"
              className="w-full rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-fuchsia-100"
            >
              Download button preset
            </button>
          </div>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2">
        {HARDWARE_ACTIONS.map((action) => (
          <div
            key={action.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-white">{action.label}</p>
              <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
                {hardwareInputLabel(bindings[action.id].keyboard)} / {hardwareInputLabel(bindings[action.id].midi)}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onLearn(action.id)}
                className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black uppercase ${
                  learnTarget === action.id
                    ? 'bg-fuchsia-500 text-white'
                    : 'border border-cyan-500/30 bg-cyan-500/10 text-cyan-200'
                }`}
              >
                {learnTarget === action.id ? 'Hit input' : 'Learn'}
              </button>
              <button
                type="button"
                onClick={() => {
                  onClear(action.id, 'keyboard');
                  onClear(action.id, 'midi');
                }}
                className="rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-[10px] font-black uppercase text-slate-400"
              >
                Clear
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function TalentDashboard({
  session,
  requests,
  onStartSession,
  onEndSession,
  onCloseout,
  onTriage,
  onFulfill,
  onHide,
  onRemove,
  activeGigId,
  activeRooms = [],
  selectedGigId = null,
  onSelectGigId = () => {},
  previewMode = false,
  performerProfile = null,
  performerEmailVerified = true
}: TalentDashboardProps) {
  const writableGigId = selectedGigId ?? activeGigId;
  const defaultPerformerName = performerProfile?.display_name?.trim() || performerProfile?.handle?.trim() || '';
  const welcomePerformerName = defaultPerformerName || session.talentName || 'Performer';
  const [mobilePanel, setMobilePanel] = useState<'live' | 'share' | 'settings'>('live');
  const [inactiveWorkspace, setInactiveWorkspace] = useState<InactivePerformerWorkspace>('home');
  const [timeLeft, setTimeLeft] = useState<string>('05:00');
  const [liveLinkCopied, setLiveLinkCopied] = useState(false);

  const [librarySourceLabel, setLibrarySourceLabel] = useState('Primary Library');
  const [libraryLinkStatus, setLibraryLinkStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);
  const [libraryLinkMessage, setLibraryLinkMessage] = useState<string | null>(null);
  const [linkedSources, setLinkedSources] = useState<Array<{
    id: string;
    sourceKey: string;
    sourceLabel: string;
    syncKeyPreview: string;
    connectionStatus: string;
    lastSyncedAt: string | null;
    trackCount: number;
  }>>([]);
  const [musicSourceCapabilities, setMusicSourceCapabilities] = useState<MusicSourceCapability[]>(DEFAULT_MUSIC_SOURCE_CAPABILITIES);
  const [musicSourceCapabilityStatus, setMusicSourceCapabilityStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [musicSourceCapabilityError, setMusicSourceCapabilityError] = useState<string | null>(null);
  const [spotifyPlaylistUrl, setSpotifyPlaylistUrl] = useState('');
  const [spotifyImportStatus, setSpotifyImportStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [spotifyImportMessage, setSpotifyImportMessage] = useState<string | null>(null);
  const [externalLibraryTracks, setExternalLibraryTracks] = useState<RequestLibraryTrack[]>([]);
  const [requestLibraryStatus, setRequestLibraryStatus] = useState<'idle' | 'loading' | 'error'>('loading');
  const [requestLibraryError, setRequestLibraryError] = useState<string | null>(null);
  const [showAdvancedLibrary, setShowAdvancedLibrary] = useState(false);
  const [issuedSyncKey, setIssuedSyncKey] = useState<{
    sourceKey: string;
    sourceLabel: string;
    syncKey: string;
    syncEndpointPath: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [queueActionPendingKey, setQueueActionPendingKey] = useState<string | null>(null);
  const queueActionPendingRef = useRef<string | null>(null);
  const actionInFlightRef = useRef(false);
  const [hardwareBindings, setHardwareBindings] = useState<HardwareBindingMap>(() => loadHardwareBindings());
  const [hardwareControlsEnabled, setHardwareControlsEnabled] = useState(false);
  const [hardwareLearnTarget, setHardwareLearnTarget] = useState<HardwareActionId | null>(null);
  const [hardwareInputStatus, setHardwareInputStatus] = useState<'idle' | 'midi-ready' | 'midi-unavailable' | 'midi-denied'>('idle');
  const [bridgeTokenStatus, setBridgeTokenStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [bridgeTokenMessage, setBridgeTokenMessage] = useState<string | null>(null);
  const [bridgeCommand, setBridgeCommand] = useState<string | null>(null);
  const [bridgeToken, setBridgeToken] = useState<string | null>(null);
  const [bridgeSwayUrl, setBridgeSwayUrl] = useState<string | null>(null);
  const hardwareBindingsRef = useRef(hardwareBindings);
  const hardwareLearnTargetRef = useRef<HardwareActionId | null>(null);

  const postSessionJson = async (path: string, body: Record<string, unknown> = {}) => {
    if (actionInFlightRef.current) {
      throw new Error('An action is already in progress.');
    }
    actionInFlightRef.current = true;
    const payload = writableGigId ? { ...body, gig_id: writableGigId } : body;

    setActionPending(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setActionError(typeof data?.error === 'string' ? data.error : 'That action failed. Please try again.');
      } else {
        setActionError(null);
      }

      return response;
    } finally {
      actionInFlightRef.current = false;
      setActionPending(false);
    }
  };

  const queueActionKey = (requestId: string, action: 'approve' | 'veto' | 'hide' | 'remove' | 'fulfill') => `${requestId}:${action}`;
  const isQueueActionPending = (requestId: string, action: 'approve' | 'veto' | 'hide' | 'remove' | 'fulfill') =>
    queueActionPendingKey === queueActionKey(requestId, action);
  const isRequestQueueActionPending = (requestId: string) => queueActionPendingKey?.startsWith(`${requestId}:`) ?? false;
  const runQueueAction = async (
    requestId: string,
    action: 'approve' | 'veto' | 'hide' | 'remove' | 'fulfill',
    run: () => void | Promise<void>
  ) => {
    const key = queueActionKey(requestId, action);
    if (queueActionPendingRef.current) return;
    queueActionPendingRef.current = key;
    setQueueActionPendingKey(key);
    setActionError(null);
    try {
      await Promise.resolve(run());
    } catch (error) {
      console.error(error);
      setActionError('That queue action failed. Please try again.');
    } finally {
      queueActionPendingRef.current = null;
      setQueueActionPendingKey(null);
    }
  };

  // Live request window countdown.
  const [windowTimeLeft, setWindowTimeLeft] = useState<string>('');

  useEffect(() => {
    if (!session.requestsOpen || session.requestWindowMode !== 'preset' || !session.requestWindowExpiresAt) {
      setWindowTimeLeft('');
      return;
    }

    const updateTimer = () => {
      const expireMs = new Date(session.requestWindowExpiresAt!).getTime();
      const diff = expireMs - Date.now();

      if (diff <= 0) {
        setWindowTimeLeft('Expired');
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const sString = secs < 10 ? `0${secs}` : secs;
        setWindowTimeLeft(`${mins}m ${sString}s`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [session.requestsOpen, session.requestWindowMode, session.requestWindowExpiresAt]);

  const handleToggleRequests = async (open: boolean) => {
    try {
      const res = await postSessionJson('/api/session/window/toggle', { open });
      if (res.ok) window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
      setActionError('That action failed. Please try again.');
    }
  };

  useEffect(() => {
    hardwareBindingsRef.current = hardwareBindings;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HARDWARE_BINDING_STORAGE_KEY, JSON.stringify(hardwareBindings));
    }
  }, [hardwareBindings]);

  useEffect(() => {
    hardwareLearnTargetRef.current = hardwareLearnTarget;
  }, [hardwareLearnTarget]);

  const handleSetMode = async (mode: 'manual' | 'open_call' | 'crowd_autopilot') => {
    try {
      const res = await postSessionJson('/api/session/mode', { mode });
      if (res.ok) window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
      setActionError('That action failed. Please try again.');
    }
  };

  const handleSetSearchScope = async (scope: 'library' | 'catalog' | 'setlist') => {
    try {
      const res = await postSessionJson('/api/session/search-scope', { scope });
      if (res.ok) window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
      setActionError('That action failed. Please try again.');
    }
  };

  const handleSetPaymentsEnabled = async (enabled: boolean) => {
    try {
      const res = await postSessionJson('/api/session/payments-enabled', { enabled });
      if (res.ok) window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
      setActionError('That action failed. Please try again.');
    }
  };

  const refreshLinkedSources = async () => {
    if (previewMode) return;
    try {
      const response = await fetch('/api/talent/library/sources');
      if (!response.ok) return;
      const data = await response.json();
      setLinkedSources(Array.isArray(data?.sources) ? data.sources : []);
    } catch (error) {
      console.warn('Unable to load linked library sources:', error);
    }
  };

  const refreshRequestLibrary = async () => {
    if (previewMode) {
      setExternalLibraryTracks([]);
      setRequestLibraryStatus('idle');
      return;
    }
    setRequestLibraryStatus('loading');
    try {
      const response = await fetch('/api/talent/library/tracks', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not load your music.');
      setExternalLibraryTracks(Array.isArray(data?.external?.tracks) ? data.external.tracks : []);
      setRequestLibraryError(null);
      setRequestLibraryStatus('idle');
    } catch (error) {
      setRequestLibraryError(error instanceof Error ? error.message : 'Could not load your music.');
      setRequestLibraryStatus('error');
    }
  };

  useEffect(() => {
    void refreshLinkedSources();
    void refreshRequestLibrary();
  }, [previewMode]);

  useEffect(() => {
    if (inactiveWorkspace === 'library' && !showAdvancedLibrary) void refreshRequestLibrary();
  }, [inactiveWorkspace, showAdvancedLibrary]);

  const refreshMusicSourceCapabilities = async () => {
    if (previewMode) {
      setMusicSourceCapabilities(DEFAULT_MUSIC_SOURCE_CAPABILITIES);
      setMusicSourceCapabilityStatus('idle');
      setMusicSourceCapabilityError(null);
      return;
    }

    setMusicSourceCapabilityStatus('loading');
    try {
      const response = await fetch('/api/talent/music/source-capabilities');
      if (!response.ok) throw new Error('Unable to load music source capabilities.');
      const data = await response.json().catch(() => null);
      setMusicSourceCapabilities(Array.isArray(data?.providers) ? data.providers : DEFAULT_MUSIC_SOURCE_CAPABILITIES);
      setMusicSourceCapabilityStatus('idle');
      setMusicSourceCapabilityError(null);
    } catch (error) {
      console.warn('Unable to load music source capabilities:', error);
      setMusicSourceCapabilities(DEFAULT_MUSIC_SOURCE_CAPABILITIES);
      setMusicSourceCapabilityStatus('error');
      setMusicSourceCapabilityError('Using local source capability defaults until Sway can refresh provider status.');
    }
  };

  useEffect(() => {
    void refreshMusicSourceCapabilities();
  }, [previewMode]);

  const linkedSourceCount = linkedSources.filter((source) => source.connectionStatus !== 'revoked').length;
  const linkedTrackCount = linkedSources
    .filter((source) => source.connectionStatus !== 'revoked')
    .reduce((sum, source) => sum + (Number(source.trackCount) || 0), 0);

  const handleSpotifyPlaylistImport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (previewMode || spotifyImportStatus === 'submitting' || !spotifyPlaylistUrl.trim()) return;

    setSpotifyImportStatus('submitting');
    setSpotifyImportMessage(null);
    try {
      const response = await fetch('/api/talent/music/spotify/import-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistUrl: spotifyPlaylistUrl.trim() })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Spotify playlist import failed.');
      }

      setSpotifyImportStatus('success');
      setSpotifyImportMessage(`Imported ${data?.importedCount ?? 0} Spotify metadata tracks into My Library.`);
      setSpotifyPlaylistUrl('');
      await refreshLinkedSources();
      await refreshMusicSourceCapabilities();
      await refreshRequestLibrary();
    } catch (error) {
      console.warn('Spotify playlist import failed:', error);
      setSpotifyImportStatus('error');
      setSpotifyImportMessage(error instanceof Error ? error.message : 'Spotify playlist import failed.');
    }
  };

  const [stripeConnectStatus, setStripeConnectStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [stripeConnectError, setStripeConnectError] = useState<string | null>(null);

  const handleConnectStripe = async () => {
    if (previewMode || stripeConnectStatus === 'submitting') return;
    setStripeConnectStatus('submitting');
    setStripeConnectError(null);
    try {
      const response = await fetch('/api/talent/connect/onboard', { method: 'POST' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to start Stripe onboarding.');
      }
      if (typeof data?.url === 'string') {
        window.location.href = data.url;
        return;
      }
      throw new Error('Stripe did not return an onboarding link.');
    } catch (error) {
      setStripeConnectStatus('error');
      setStripeConnectError(error instanceof Error ? error.message : 'Unable to start Stripe onboarding.');
    }
  };

  const handleLibraryLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (previewMode || libraryLinkStatus === 'submitting') return;

    setLibraryLinkStatus('submitting');
    setLibraryLinkMessage(null);
    setIssuedSyncKey(null);

    try {
      const response = await fetch('/api/talent/library/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceKey: librarySourceLabel,
          sourceLabel: librarySourceLabel
        })
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Library link failed.');
      }

      setLibraryLinkStatus('success');
      setLibraryLinkMessage(`Linked ${data?.sourceLabel ?? librarySourceLabel}. Use the sync key below from any compatible program or companion tool.`);
      setIssuedSyncKey(data);
      await refreshLinkedSources();
    } catch (error) {
      setLibraryLinkStatus('error');
      setLibraryLinkMessage(error instanceof Error ? error.message : 'Library link failed.');
    }
  };

  const handleRotateLinkedSource = async (sourceId: string) => {
    if (previewMode) return;
    setPendingSourceId(sourceId);
    setLibraryLinkMessage(null);
    try {
      const response = await fetch(`/api/talent/library/sources/${sourceId}/rotate-key`, {
        method: 'POST'
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to rotate sync key.');
      }
      setIssuedSyncKey(data);
      setLibraryLinkStatus('success');
      setLibraryLinkMessage(`Rotated sync key for ${data?.sourceLabel ?? 'linked source'}. Update the connected program now.`);
      await refreshLinkedSources();
    } catch (error) {
      setLibraryLinkStatus('error');
      setLibraryLinkMessage(error instanceof Error ? error.message : 'Unable to rotate sync key.');
    } finally {
      setPendingSourceId(null);
    }
  };

  const handleRevokeLinkedSource = async (sourceId: string, sourceLabel: string) => {
    if (previewMode) return;
    setPendingSourceId(sourceId);
    setLibraryLinkMessage(null);
    try {
      const response = await fetch(`/api/talent/library/sources/${sourceId}/revoke`, {
        method: 'POST'
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to revoke linked source.');
      }
      setIssuedSyncKey(null);
      setLibraryLinkStatus('success');
      setLibraryLinkMessage(`Revoked ${sourceLabel}. Existing sync keys for that source will no longer work.`);
      await refreshLinkedSources();
    } catch (error) {
      setLibraryLinkStatus('error');
      setLibraryLinkMessage(error instanceof Error ? error.message : 'Unable to revoke linked source.');
    } finally {
      setPendingSourceId(null);
    }
  };

  // Compute 5-minute countdown clock
  useEffect(() => {
    if (session.status !== 'ending' || !session.endGigTimerStartedAt) return;

    const interval = setInterval(() => {
      const startMs = new Date(session.endGigTimerStartedAt!).getTime();
      const difference = 300000 - (Date.now() - startMs);

      if (difference <= 0) {
        clearInterval(interval);
        onCloseout();
      } else {
        const mins = Math.floor(difference / 60000);
        const secs = Math.floor((difference % 60000) / 1000);
        const formattedSecs = secs < 10 ? `0${secs}` : secs;
        setTimeLeft(`0${mins}:${formattedSecs}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [session.status, session.endGigTimerStartedAt, onCloseout]);

  // Derived filter collections
  const triageQueue = requests.filter(r => r.status === 'hold' && !r.shadowBanned && !r.hidden && !r.removed);
  const liveLadderQueue = requests
    .filter(r => r.status === 'approved' && !r.hidden && !r.removed)
    .sort((a, b) => b.amount - a.amount); // SORTED BY LOWER TO HIGHEST OR HIGH TO LOW (AUCTION VALUE)
  const fulfilledHistory = requests.filter(r => (r.status === 'fulfilled' || r.type === 'tip') && !r.hidden && !r.removed);
  const poolBackersCount = requests
    .filter(r => !r.hidden && !r.removed)
    .reduce((sum, r) => sum + Math.max(1, r.sponsorCount), 0);
  const requestScopeLabel = session.searchScope === 'setlist'
    ? 'Setlist source'
    : session.searchScope === 'catalog'
      ? 'Open requests'
      : 'My Library';
  const isCrowdAutopilot = session.operatingMode === 'crowd_autopilot';
  const leadingApprovedRequest = liveLadderQueue[0] ?? null;
  const operatorNextAction = isCrowdAutopilot
    ? 'Autopilot live'
    : triageQueue.length > 0
    ? 'Review pending'
    : leadingApprovedRequest
      ? 'Mark playing'
      : 'Share room';
  const operatorNextDetail = isCrowdAutopilot
    ? (leadingApprovedRequest
      ? `${leadingApprovedRequest.title} is leading the crowd-ranked queue.`
      : 'Clean requests jump straight to up next; use pause or veto only when needed.')
    : triageQueue.length > 0
    ? `${triageQueue.length} request${triageQueue.length === 1 ? '' : 's'} waiting for approve or veto.`
    : leadingApprovedRequest
      ? `${leadingApprovedRequest.title} is leading the approved queue.`
      : 'Copy the room link or show the QR so the crowd can start sending requests.';
  const selectedRoomLink = selectedGigId ?? activeGigId;
  const selectedRoomUrl = resolveLiveRoomLink(selectedRoomLink);
  const handleCopyLiveRoomLink = async () => {
    if (!selectedRoomUrl) return;
    await copyRoomLink(selectedRoomUrl);
    setLiveLinkCopied(true);
  };

  useEffect(() => {
    if (!liveLinkCopied) return;
    const timeout = window.setTimeout(() => setLiveLinkCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [liveLinkCopied]);
  const runHardwareAction = (actionId: HardwareActionId) => {
    if (previewMode || actionInFlightRef.current) return;
    const topApproved = liveLadderQueue[0] ?? null;
    const topPending = triageQueue[0] ?? null;

    if (actionId === 'toggle_requests') {
      void handleToggleRequests(!session.requestsOpen);
      return;
    }
    if (actionId === 'fulfill_top' && topApproved) {
      onFulfill(topApproved.id);
      return;
    }
    if (actionId === 'hide_top' && topApproved) {
      onHide(topApproved.id);
      return;
    }
    if (actionId === 'approve_pending' && topPending) {
      onTriage(topPending.id, 'approve');
      return;
    }
    if (actionId === 'veto_pending' && topPending) {
      onTriage(topPending.id, 'deny');
      return;
    }
    if (actionId === 'open_top_source' && topApproved?.spotifyUrl) {
      window.open(topApproved.spotifyUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const learnHardwareInput = (actionId: HardwareActionId, kind: keyof HardwareBinding, value: string) => {
    setHardwareBindings((current) => ({
      ...current,
      [actionId]: {
        ...current[actionId],
        [kind]: value
      }
    }));
    setHardwareLearnTarget(null);
  };

  const clearHardwareInput = (actionId: HardwareActionId, kind: keyof HardwareBinding) => {
    setHardwareBindings((current) => ({
      ...current,
      [actionId]: {
        ...current[actionId],
        [kind]: null
      }
    }));
  };

  const issueBridgeToken = async () => {
    if (!writableGigId || bridgeTokenStatus === 'submitting') return;
    setBridgeTokenStatus('submitting');
    setBridgeTokenMessage(null);
    setBridgeCommand(null);
    setBridgeToken(null);
    setBridgeSwayUrl(null);

    try {
      const response = await postSessionJson('/api/talent/control-bridge/token');
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to create bridge token.');
      }

      setBridgeTokenStatus('success');
      setBridgeTokenMessage(`Token expires ${data?.expiresAt ? new Date(data.expiresAt).toLocaleTimeString() : 'after issue'}.`);
      setBridgeCommand(typeof data?.command === 'string' ? data.command : null);
      setBridgeToken(typeof data?.bridgeToken === 'string' ? data.bridgeToken : null);
      setBridgeSwayUrl(typeof data?.swayUrl === 'string' ? data.swayUrl : null);
    } catch (error) {
      setBridgeTokenStatus('error');
      setBridgeTokenMessage(error instanceof Error ? error.message : 'Unable to create bridge token.');
    }
  };

  const downloadBridgePreset = () => {
    if (!bridgeCommand || !bridgeToken || !bridgeSwayUrl) return;
    const safeGigId = (writableGigId ?? 'live-room').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'live-room';
    downloadJsonFile(
      `sway-control-bridge-${safeGigId}.json`,
      buildDashboardBridgePreset({
        gigId: writableGigId,
        bridgeToken,
        swayUrl: bridgeSwayUrl,
        bridgeCommand
      })
    );
  };

  useEffect(() => {
    if (session.status === 'inactive' || !hardwareControlsEnabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const targetTag = target?.tagName?.toLowerCase();
      if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select' || target?.isContentEditable) return;

      const learnTarget = hardwareLearnTargetRef.current;
      if (learnTarget) {
        event.preventDefault();
        learnHardwareInput(learnTarget, 'keyboard', event.code);
        return;
      }

      const match = HARDWARE_ACTIONS.find((action) => hardwareBindingsRef.current[action.id].keyboard === event.code);
      if (!match) return;
      event.preventDefault();
      runHardwareAction(match.id);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session.status, session.requestsOpen, previewMode, liveLadderQueue, triageQueue, hardwareControlsEnabled]);

  useEffect(() => {
    if (session.status === 'inactive' || !hardwareControlsEnabled) {
      setHardwareInputStatus('idle');
      return;
    }
    let cancelled = false;
    let midiAccess: any = null;

    const onMidiMessage = (event: { data?: Uint8Array }) => {
      if (!event.data) return;
      const binding = resolveMidiBinding(event.data);
      if (!binding) return;

      const learnTarget = hardwareLearnTargetRef.current;
      if (learnTarget) {
        learnHardwareInput(learnTarget, 'midi', binding);
        return;
      }

      const match = HARDWARE_ACTIONS.find((action) => hardwareBindingsRef.current[action.id].midi === binding);
      if (match) runHardwareAction(match.id);
    };

    const connectMidi = async () => {
      const requestMIDIAccess = (navigator as any).requestMIDIAccess;
      if (typeof requestMIDIAccess !== 'function') {
        setHardwareInputStatus('midi-unavailable');
        return;
      }

      try {
        midiAccess = await requestMIDIAccess.call(navigator);
        if (cancelled) return;
        setHardwareInputStatus('midi-ready');
        midiAccess.inputs.forEach((input: { onmidimessage: ((event: { data?: Uint8Array }) => void) | null }) => {
          input.onmidimessage = onMidiMessage;
        });
      } catch {
        if (!cancelled) setHardwareInputStatus('midi-denied');
      }
    };

    void connectMidi();

    return () => {
      cancelled = true;
      if (midiAccess?.inputs) {
        midiAccess.inputs.forEach((input: { onmidimessage: null }) => {
          input.onmidimessage = null;
        });
      }
    };
  }, [session.status, session.requestsOpen, previewMode, liveLadderQueue, triageQueue, hardwareControlsEnabled]);

  // Formatter for currency
  const formatValue = (val: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  };

  if (session.status !== 'inactive') {
    const visiblePending = triageQueue.slice(0, 4);
    const visibleApproved = liveLadderQueue.slice(0, 5);
    const overflowPending = Math.max(0, triageQueue.length - visiblePending.length);
    const overflowApproved = Math.max(0, liveLadderQueue.length - visibleApproved.length);
    const roomOpenLabel = session.requestsOpen ? 'Open' : 'Paused';
    const roomStatusTone = session.requestsOpen ? 'text-emerald-300' : 'text-rose-300';

    return (
      <div
        id="talent_dashboard_panel"
        data-sway-performer-live-cockpit="true"
        className="relative h-[var(--sway-viewport-height,100vh)] overflow-hidden bg-slate-950 p-2 text-slate-100 sm:p-3"
      >
        {hardwareControlsEnabled ? (
          <div
            data-sway-hardware-controls-enabled="true"
            className="absolute inset-0 z-50 overflow-y-auto bg-slate-950/95 p-3 backdrop-blur"
            role="dialog"
            aria-modal="true"
            aria-label="Advanced key controls"
          >
            <div className="mx-auto max-w-2xl space-y-2">
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-900 px-4 py-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-white">Hardware controls are on</p>
                  <p className="mt-1 text-[10px] text-slate-400">Keyboard and MIDI actions only listen while this panel is open.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setHardwareLearnTarget(null);
                    setHardwareControlsEnabled(false);
                  }}
                  className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-xs font-black uppercase text-slate-200"
                >
                  Done
                </button>
              </div>
              <HardwareMappingPanel
                bindings={hardwareBindings}
                learnTarget={hardwareLearnTarget}
                midiStatus={hardwareInputStatus}
                bridgeCommand={bridgeCommand}
                bridgeTokenStatus={bridgeTokenStatus}
                bridgeTokenMessage={bridgeTokenMessage}
                onLearn={setHardwareLearnTarget}
                onClear={clearHardwareInput}
                onIssueBridgeToken={issueBridgeToken}
                onDownloadBridgePreset={downloadBridgePreset}
              />
            </div>
          </div>
        ) : null}
        <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_auto_minmax(0,1fr)_auto] gap-2 landscape:grid-rows-[auto_auto_minmax(0,1fr)_auto]">
          {actionError ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-100">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{actionError}</span>
                <button type="button" onClick={() => setActionError(null)} className="shrink-0 text-rose-200">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : null}

          <header className="grid gap-2 rounded-2xl border border-white/10 bg-slate-900/90 p-3 shadow-xl landscape:grid-cols-[minmax(0,1fr)_auto] landscape:items-center">
            <div className="flex min-w-0 items-center gap-3">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-slate-950 text-cyan-300">
                <span className={`absolute -right-1 -top-1 h-3 w-3 rounded-full ${session.requestsOpen ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <Radio className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate font-display text-base font-black uppercase tracking-wide text-white">
                  {session.talentName || welcomePerformerName}
                </p>
                <p className="truncate text-[11px] font-bold text-slate-400">
                  {session.status === 'ending' ? `Ending room - closeout ${timeLeft}` : `${session.talentRole} live room`}
                </p>
                {activeRooms.length > 0 ? (
                  <label className="mt-1 flex min-w-0 items-center gap-1 text-[9px] font-bold text-slate-500">
                    <span className="shrink-0 uppercase tracking-wider">Room</span>
                    <select
                      data-sway-room-selector="true"
                      value={selectedGigId ?? activeGigId ?? ''}
                      onChange={(event) => onSelectGigId(event.target.value || null)}
                      className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-mono text-[9px] text-cyan-300 outline-none"
                      aria-label="Active room"
                    >
                      {activeRooms.map((room) => (
                        <option key={room.gigId} value={room.gigId} className="bg-slate-950 text-white">
                          {room.performerName} · {room.gigId.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1.5 text-center landscape:w-[23rem]">
              {[
                [isCrowdAutopilot ? 'Review' : 'Pending', triageQueue.length, 'text-amber-300'],
                [isCrowdAutopilot ? 'Crowd' : 'Approved', liveLadderQueue.length, 'text-cyan-300'],
                ['Backers', poolBackersCount, 'text-fuchsia-300'],
                ['Mode', isCrowdAutopilot ? 'Auto' : roomOpenLabel, isCrowdAutopilot ? 'text-fuchsia-300' : roomStatusTone]
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-xl border border-white/10 bg-slate-950 px-2 py-2">
                  <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">{label}</p>
                  <p className={`mt-0.5 truncate font-mono text-sm font-black ${tone}`}>{value}</p>
                </div>
              ))}
            </div>
          </header>

          <section className="grid grid-cols-3 gap-2 text-center" aria-label="Tonight's money rules">
            <div className="rounded-xl border border-white/10 bg-slate-900 px-2 py-2">
              <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">
                {session.paymentsEnabled === false ? 'Requests' : 'Minimum request'}
              </p>
              <p className="mt-0.5 truncate font-mono text-sm font-black text-white">
                {session.paymentsEnabled === false ? 'Free' : formatValue(session.minimumTip)}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-900 px-2 py-2">
              <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Boost minimum</p>
              <p className="mt-0.5 truncate font-mono text-sm font-black text-white">
                {session.paymentsEnabled === false ? 'Free upvotes' : formatValue(session.minimumTip)}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-900 px-2 py-2">
              <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Tip path</p>
              <p className="mt-0.5 truncate font-mono text-sm font-black text-white">
                <span className="min-[360px]:hidden">Tips</span>
                <span className="hidden min-[360px]:inline">Direct tips</span>
              </p>
            </div>
          </section>

          <div className="h-32 min-h-0 landscape:hidden">
            <PerformerAudienceScreen
              activeGigId={selectedGigId ?? activeGigId}
              session={session}
              approvedQueue={liveLadderQueue}
            />
          </div>

          <section className="grid grid-cols-3 gap-2 landscape:hidden" aria-label="Live-night sections">
            {[
              { id: 'live', label: 'Live' },
              { id: 'share', label: 'Show QR' },
              { id: 'settings', label: 'Control' }
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMobilePanel(item.id as 'live' | 'share' | 'settings')}
                className={`min-h-10 rounded-xl px-2 text-xs font-black uppercase tracking-wide ${
                  mobilePanel === item.id ? 'bg-cyan-500 text-slate-950' : 'border border-white/10 bg-slate-900 text-slate-300'
                }`}
              >
                {item.label}
              </button>
            ))}
          </section>

          <main className="min-h-0 min-w-0 overflow-hidden">
            <div className="hidden h-full min-h-0 gap-2 landscape:grid landscape:grid-cols-[minmax(0,1fr)_minmax(280px,0.45fr)]">
              <div className="grid min-h-0 grid-cols-2 gap-2">
                <CompactRequestPanel
                  title="Pending"
                  empty={isCrowdAutopilot ? 'Autopilot is moving clean requests into the queue.' : 'No pending requests.'}
                  overflowCount={overflowPending}
                  requests={visiblePending}
                  paymentsEnabled={session.paymentsEnabled !== false}
                  renderActions={(request) => (
                    <>
                      <button
                        type="button"
                        onClick={() => void runQueueAction(request.id, 'approve', () => onTriage(request.id, 'approve'))}
                        disabled={previewMode || isRequestQueueActionPending(request.id)}
                        data-sway-queue-action-pending={isQueueActionPending(request.id, 'approve') ? 'true' : 'false'}
                        className="bg-emerald-500 text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void runQueueAction(request.id, 'veto', () => onTriage(request.id, 'deny'))}
                        disabled={previewMode || isRequestQueueActionPending(request.id)}
                        data-sway-queue-action-pending={isQueueActionPending(request.id, 'veto') ? 'true' : 'false'}
                        className="bg-rose-500 text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  )}
                />
                <CompactRequestPanel
                  title="Approved"
                  empty={isCrowdAutopilot ? 'Waiting for the crowd to pick what is next.' : 'No approved queue yet.'}
                  overflowCount={overflowApproved}
                  requests={visibleApproved}
                  paymentsEnabled={session.paymentsEnabled !== false}
                  renderActions={(request) => (
                    <>
                      <button
                        type="button"
                        onClick={() => void runQueueAction(request.id, 'fulfill', () => onFulfill(request.id))}
                        disabled={previewMode || isRequestQueueActionPending(request.id)}
                        data-sway-queue-action-pending={isQueueActionPending(request.id, 'fulfill') ? 'true' : 'false'}
                        className="bg-cyan-500 text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void runQueueAction(request.id, 'hide', () => onHide(request.id))}
                        disabled={previewMode || isRequestQueueActionPending(request.id)}
                        data-sway-queue-action-pending={isQueueActionPending(request.id, 'hide') ? 'true' : 'false'}
                        className="border border-white/10 bg-slate-950 text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <SpotifyOpenLink request={request} />
                    </>
                  )}
                />
              </div>
              <PerformerAudienceScreen
                activeGigId={selectedGigId ?? activeGigId}
                session={session}
                approvedQueue={liveLadderQueue}
              />
            </div>

            <div className="h-full min-h-0 min-w-0 landscape:hidden">
              {mobilePanel === 'live' ? (
                <div className="grid h-full min-h-0 grid-rows-2 gap-2">
                  <CompactRequestPanel
                    title="Pending"
                    empty={isCrowdAutopilot ? 'Autopilot is moving clean requests into the queue.' : 'No pending requests.'}
                    overflowCount={overflowPending}
                    requests={visiblePending.slice(0, 3)}
                    paymentsEnabled={session.paymentsEnabled !== false}
                    renderActions={(request) => (
                      <>
                        <button
                          type="button"
                          onClick={() => void runQueueAction(request.id, 'approve', () => onTriage(request.id, 'approve'))}
                          disabled={previewMode || isRequestQueueActionPending(request.id)}
                          data-sway-queue-action-pending={isQueueActionPending(request.id, 'approve') ? 'true' : 'false'}
                          className="bg-emerald-500 text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void runQueueAction(request.id, 'veto', () => onTriage(request.id, 'deny'))}
                          disabled={previewMode || isRequestQueueActionPending(request.id)}
                          data-sway-queue-action-pending={isQueueActionPending(request.id, 'veto') ? 'true' : 'false'}
                          className="bg-rose-500 text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  />
                  <CompactRequestPanel
                    title="Approved"
                    empty={isCrowdAutopilot ? 'Waiting for the crowd to pick what is next.' : 'No approved queue yet.'}
                    overflowCount={overflowApproved}
                    requests={visibleApproved.slice(0, 3)}
                    paymentsEnabled={session.paymentsEnabled !== false}
                    renderActions={(request) => (
                      <>
                        <button
                          type="button"
                          onClick={() => void runQueueAction(request.id, 'fulfill', () => onFulfill(request.id))}
                          disabled={previewMode || isRequestQueueActionPending(request.id)}
                          data-sway-queue-action-pending={isQueueActionPending(request.id, 'fulfill') ? 'true' : 'false'}
                          className="bg-cyan-500 text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Play className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void runQueueAction(request.id, 'hide', () => onHide(request.id))}
                          disabled={previewMode || isRequestQueueActionPending(request.id)}
                          data-sway-queue-action-pending={isQueueActionPending(request.id, 'hide') ? 'true' : 'false'}
                          className="border border-white/10 bg-slate-950 text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <X className="h-4 w-4" />
                        </button>
                        <SpotifyOpenLink request={request} />
                      </>
                    )}
                  />
                </div>
              ) : mobilePanel === 'share' ? (
                <PerformerRoomShare activeGigId={selectedGigId ?? activeGigId} />
              ) : (
                <PerformerRoomControls
                  session={session}
                  requestScopeLabel={requestScopeLabel}
                  selectedRoomLink={selectedRoomLink}
                  operatorNextAction={operatorNextAction}
                  operatorNextDetail={operatorNextDetail}
                  actionPending={actionPending}
                  onToggleRequests={handleToggleRequests}
                  onSetMode={handleSetMode}
                  onSetSearchScope={handleSetSearchScope}
                  onEndSession={onEndSession}
                />
              )}
            </div>
          </main>

          <footer className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]">
            <div className="min-w-0 rounded-xl border border-white/10 bg-slate-900 px-3 py-2">
              <p className="truncate text-[11px] font-bold text-white">{operatorNextAction}</p>
              <p className="truncate text-[10px] text-slate-400">{operatorNextDetail}</p>
            </div>
            <button
              type="button"
              onClick={handleCopyLiveRoomLink}
              disabled={!selectedRoomUrl}
              className="hidden min-h-12 rounded-xl bg-fuchsia-600 px-3 text-xs font-black uppercase tracking-wide text-white disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500 sm:block"
            >
              {liveLinkCopied ? 'Copied' : 'Copy link'}
            </button>
            <button
              type="button"
              data-sway-enable-hardware-controls="true"
              onClick={() => setHardwareControlsEnabled(true)}
              className="hidden min-h-12 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-black uppercase tracking-wide text-cyan-200 sm:block"
            >
              Keys
            </button>
            <button
              type="button"
              onClick={() => handleToggleRequests(!session.requestsOpen)}
              disabled={actionPending}
              className={`min-h-12 rounded-xl px-4 text-xs font-black uppercase tracking-wide text-slate-950 disabled:opacity-60 ${
                session.requestsOpen ? 'bg-rose-500' : 'bg-emerald-500'
              }`}
            >
              {session.requestsOpen ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button"
              onClick={previewMode ? undefined : session.status === 'ending' ? onCloseout : onEndSession}
              disabled={previewMode || (session.status !== 'active' && session.status !== 'ending')}
              className="min-h-12 rounded-xl border border-white/10 bg-slate-900 px-3 text-xs font-black uppercase tracking-wide text-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {session.status === 'ending' ? 'Recap' : 'End'}
            </button>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div id="talent_dashboard_panel" className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:py-6">

      {actionError && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-rose-200">{actionError}</p>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="shrink-0 text-rose-300 hover:text-rose-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <nav
        data-sway-performer-app-navigation="true"
        aria-label="Performer console sections"
        className="sticky top-0 z-20 order-1 mx-auto grid w-full max-w-3xl grid-cols-3 gap-1 rounded-2xl border border-white/10 bg-slate-950/95 p-1.5 shadow-2xl backdrop-blur sm:grid-cols-5"
      >
        {INACTIVE_PERFORMER_NAVIGATION.map(({ id, label, icon: Icon }) => {
          const selected = inactiveWorkspace === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => {
                setInactiveWorkspace(id);
                if (id === 'library') setShowAdvancedLibrary(false);
              }}
              className={`inline-flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-[10px] font-black uppercase tracking-wider transition sm:flex-row sm:text-xs ${
                selected
                  ? 'bg-fuchsia-600 text-white shadow-lg shadow-fuchsia-950/40'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      {/* 1. Header & Live Stand Indicators */}
      {inactiveWorkspace === 'room' ? (
        <div className="order-2 flex flex-col justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900 p-6 glass-panel glow-fuchsia md:flex-row md:items-center">
          <div className="flex items-center gap-4">
            <div className="relative">
              <span className="absolute -top-1.5 -right-1.5 flex h-3 w-3 font-sans">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-75"></span>
                <span className="relative inline-flex h-3 w-3 rounded-full bg-fuchsia-500"></span>
              </span>
              <div className="w-12 h-12 rounded-xl bg-slate-950 border border-white/10 flex items-center justify-center text-fuchsia-400">
                <Radio className="w-6 h-6" />
              </div>
            </div>
            <div className="font-sans">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg font-bold text-white tracking-wide uppercase">
                  Start a Room
                </h2>
              </div>
              <p className="text-xs text-slate-400 font-sans mt-0.5">
                Choose tonight's request rules, then create a print-ready room link and QR.
              </p>
              {previewMode && (
                <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-amber-200">
                  Demo data only; no live tips are being collected.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {inactiveWorkspace === 'profile' ? (
        <div className="order-2">
          <PerformerPublicProfileEditor performerHandle={performerProfile?.handle} previewMode={previewMode} />
        </div>
      ) : null}

      {/* Library work stays separate from live-room operation and account administration. */}
      {inactiveWorkspace === 'library' && !showAdvancedLibrary ? (
        <div className="order-2">
          <RequestLibraryWorkspace
            externalTracks={externalLibraryTracks}
            loading={requestLibraryStatus === 'loading'}
            error={requestLibraryError}
            spotifyPlaylistUrl={spotifyPlaylistUrl}
            spotifyImportStatus={spotifyImportStatus}
            spotifyImportMessage={spotifyImportMessage}
            onSpotifyPlaylistUrlChange={setSpotifyPlaylistUrl}
            onSpotifyPlaylistImport={handleSpotifyPlaylistImport}
            onOpenAdvanced={() => setShowAdvancedLibrary(true)}
          />
        </div>
      ) : null}

      {inactiveWorkspace === 'library' && showAdvancedLibrary ? (
        <div className="order-2">
          <button type="button" onClick={() => setShowAdvancedLibrary(false)} className="mx-auto mb-3 block w-full max-w-3xl text-left text-sm font-bold text-cyan-200">← Back to your music</button>
          <details
            open
            data-sway-library-workspace="true"
            className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-slate-900/70 p-4 shadow-lg"
          >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-left">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Request library</p>
            <p className="mt-1 text-xs text-slate-500">Synced playlists and external music sources used for audience requests.</p>
          </div>
          <span className="shrink-0 rounded-full border border-white/10 bg-slate-950 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-300">
            Manage
          </span>
        </summary>
        <div className="mt-5 space-y-5">
      <MusicSourcesPanel
        providers={musicSourceCapabilities}
        linkedSourceCount={linkedSourceCount}
        syncedTrackCount={linkedTrackCount}
        loading={musicSourceCapabilityStatus === 'loading'}
        loadError={musicSourceCapabilityError}
        spotifyPlaylistUrl={spotifyPlaylistUrl}
        spotifyImportStatus={spotifyImportStatus}
        spotifyImportMessage={spotifyImportMessage}
        onSpotifyPlaylistUrlChange={setSpotifyPlaylistUrl}
        onSpotifyPlaylistImport={handleSpotifyPlaylistImport}
      />

      <details className="group max-w-3xl mx-auto rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-lg">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 text-left">
          <div>
            <h4 className="font-display text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">Link Any Library Program</h4>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              For technical users only. Requires writing or running a small script that sends your track list to Sway — there's no built-in connector for Serato, rekordbox, Traktor, or other DJ software yet.
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Most performers don't need this. Use it only when you already have a library bridge workflow.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-white/10 bg-slate-950 px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-slate-300">
            <span className="group-open:hidden">Expand</span>
            <span className="hidden group-open:inline">Collapse</span>
          </span>
        </summary>

        <form className="mt-4 space-y-3" onSubmit={handleLibraryLink}>
          <div className="space-y-1.5">
            <label className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Source label</label>
            <input
              type="text"
              value={librarySourceLabel}
              onChange={(event) => setLibrarySourceLabel(event.target.value)}
              placeholder="Custom script, laptop bridge, booth PC"
              className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-3 text-sm font-semibold text-white outline-none focus:border-emerald-500"
            />
          </div>

          {libraryLinkMessage ? (
            <div
              className={`rounded-xl px-3 py-3 text-xs ${
                libraryLinkStatus === 'success'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                  : 'border border-rose-500/20 bg-rose-500/10 text-rose-100'
              }`}
            >
              {libraryLinkMessage}
            </div>
          ) : null}

          {issuedSyncKey ? (
            <div className="rounded-xl border border-emerald-500/20 bg-slate-950 px-3 py-3 text-xs text-slate-300">
              <p className="text-[9px] font-mono uppercase tracking-widest text-emerald-300">Sync endpoint</p>
              <p className="mt-2 break-all font-mono text-white">{issuedSyncKey.syncEndpointPath}</p>
              <p className="mt-3 text-[9px] font-mono uppercase tracking-widest text-emerald-300">Sync key</p>
              <p className="mt-2 break-all font-mono text-white">{issuedSyncKey.syncKey}</p>
              <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
                Any compatible program can `POST` tracks to this endpoint with header `x-sway-library-key` set to this sync key.
              </p>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                First-party bridge: run `npm run library:bridge -- --sync-key ...` and point local software at `http://127.0.0.1:4314/ingest`.
              </p>
            </div>
          ) : null}

          {linkedSources.length > 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-950 px-3 py-3">
              <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Linked sources</p>
              <div className="mt-3 space-y-2">
                {linkedSources.map((source) => (
                  <div key={source.id} className="rounded-lg border border-white/10 bg-slate-900 px-3 py-3">
                    <p className="text-xs font-bold text-white">{source.sourceLabel}</p>
                    <p className="mt-1 text-[10px] font-mono uppercase tracking-widest text-slate-500">{source.sourceKey}</p>
                    <p className="mt-1 text-[10px] text-slate-400">Key reference: {source.syncKeyPreview}</p>
                    <p className="mt-1 text-[10px] text-slate-400">Tracks available: {source.trackCount}</p>
                    <p className="mt-1 text-[10px] text-slate-400">Status: {source.connectionStatus}</p>
                    <p className="mt-1 text-[10px] text-slate-400">
                      {source.lastSyncedAt ? `Last synced ${new Date(source.lastSyncedAt).toLocaleString()}` : 'No sync received yet'}
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => handleRotateLinkedSource(source.id)}
                        disabled={previewMode || pendingSourceId === source.id}
                        className="inline-flex min-h-10 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[10px] font-bold text-cyan-200 transition-all hover:border-cyan-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {pendingSourceId === source.id ? 'Rotating...' : 'Rotate key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRevokeLinkedSource(source.id, source.sourceLabel)}
                        disabled={previewMode || pendingSourceId === source.id || source.connectionStatus === 'revoked'}
                        className="inline-flex min-h-10 items-center justify-center rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[10px] font-bold text-rose-200 transition-all hover:border-rose-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {source.connectionStatus === 'revoked' ? 'Revoked' : 'Revoke source'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={previewMode || libraryLinkStatus === 'submitting'}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-xs font-bold text-white transition-all hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <Upload className="h-4 w-4" />
            {libraryLinkStatus === 'submitting' ? 'Creating linked source...' : 'Create linked source'}
          </button>
        </form>
      </details>

        </div>
          </details>
        </div>
      ) : null}

      {inactiveWorkspace === 'account' ? (
        <section
          data-sway-account-workspace="true"
          className="order-2 mx-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-lg"
        >
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Account</p>
            <h2 className="mt-1 font-display text-lg font-black uppercase tracking-wide text-white">Money & access</h2>
            <p className="mt-1 text-xs text-slate-500">Manage payout readiness without mixing it into your music library.</p>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950 p-4 select-none">
            <div className="min-w-0 flex items-start gap-3">
              <div className="shrink-0 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-300">
                <CreditCard className="h-4 w-4" />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Payouts</p>
                {performerProfile?.payouts_enabled ? (
                  <p className="mt-0.5 text-[11px] text-emerald-300">Payouts active. Paid requests, tips, and boosts route to your bank automatically.</p>
                ) : performerProfile?.charges_enabled ? (
                  <p className="mt-0.5 text-[11px] text-amber-300">Stripe can accept charges, but payouts still need setup.</p>
                ) : performerProfile?.stripe_connected_account_id ? (
                  <p className="mt-0.5 text-[11px] text-slate-500">Stripe onboarding has started but is not finished.</p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-slate-500">Connect Stripe before accepting paid requests, tips, or boosts.</p>
                )}
                {stripeConnectError ? <p className="mt-1 text-[10px] text-rose-400">{stripeConnectError}</p> : null}
              </div>
            </div>
            {!performerProfile?.payouts_enabled ? (
              <button
                type="button"
                onClick={handleConnectStripe}
                disabled={previewMode || stripeConnectStatus === 'submitting'}
                className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {stripeConnectStatus === 'submitting'
                  ? 'Opening Stripe...'
                  : performerProfile?.stripe_connected_account_id
                    ? 'Finish Stripe setup'
                    : 'Connect Stripe'}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {inactiveWorkspace === 'home' ? (
        <div className="order-2">
          <PerformerAccountHome
            displayName={welcomePerformerName}
            performerHandle={performerProfile?.handle}
            stripeReady={Boolean(performerProfile?.payouts_enabled)}
            onStartRoom={() => setInactiveWorkspace('room')}
            onOpenLibrary={() => {
              setShowAdvancedLibrary(false);
              setInactiveWorkspace('library');
            }}
          />
        </div>
      ) : null}

      {inactiveWorkspace === 'room' ? (
        <div id="sway-start-room" className="order-3">
          <PerformerRoomSetup
            performerName={welcomePerformerName}
            talentRole={session.talentRole === 'DJ' ? 'DJ' : 'Performer'}
            performerHandle={performerProfile?.handle}
            performerEmailVerified={performerEmailVerified}
            onStartSession={onStartSession}
          />
        </div>
      ) : null}

    </div>
  );
}
