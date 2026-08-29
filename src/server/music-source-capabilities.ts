export type MusicSourceProviderKey = 'local_library' | 'spotify' | 'soundcloud' | 'sway_upload';

export type MusicSourceCapabilitySummary = {
  providerKey: MusicSourceProviderKey;
  displayName: string;
  sourceMode: 'sync_key' | 'app_catalog' | 'oauth_provider' | 'sway_owned_audio';
  authRequirement: 'none' | 'sync_key' | 'app_credentials' | 'oauth';
  connectionStatus: 'available' | 'configured' | 'not_configured' | 'not_connected';
  capabilities: {
    searchMetadata: boolean;
    importLibrary: boolean;
    openExternal: boolean;
    playInSway: boolean;
    controlExternalPlayback: boolean;
    loadExternalTrack: boolean;
    requiresTrackAvailabilityCheck: boolean;
  };
  performerActionLabel: string;
  audienceClaim: string;
  riskNote: string;
};

export function getMusicSourceCapabilityCatalog({
  spotifyCatalogConfigured
}: {
  spotifyCatalogConfigured: boolean;
}): MusicSourceCapabilitySummary[] {
  return [
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
        controlExternalPlayback: true,
        loadExternalTrack: true,
        requiresTrackAvailabilityCheck: false
      },
      performerActionLabel: 'Load or search from the room controller',
      audienceClaim: 'Request from the performer library',
      riskNote: 'VirtualDJ supports exact-path load plus bidirectional transport through the booth bridge. Other DJ apps get one-way mapped MIDI transport. Audio stays in the DJ source.'
    },
    {
      providerKey: 'spotify',
      displayName: 'Spotify',
      sourceMode: 'app_catalog',
      authRequirement: 'app_credentials',
      connectionStatus: spotifyCatalogConfigured ? 'configured' : 'not_configured',
      capabilities: {
        searchMetadata: spotifyCatalogConfigured,
        importLibrary: false,
        openExternal: true,
        playInSway: false,
        controlExternalPlayback: false,
        loadExternalTrack: false,
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
        controlExternalPlayback: false,
        loadExternalTrack: false,
        requiresTrackAvailabilityCheck: true
      },
      performerActionLabel: 'Connect SoundCloud',
      audienceClaim: 'SoundCloud account link required',
      riskNote: 'SoundCloud access depends on OAuth, track permissions, attribution, and per-track availability.'
    },
    {
      providerKey: 'sway_upload',
      displayName: 'Sway Audio',
      sourceMode: 'sway_owned_audio',
      authRequirement: 'none',
      connectionStatus: 'not_connected',
      capabilities: {
        searchMetadata: false,
        importLibrary: false,
        openExternal: false,
        playInSway: false,
        controlExternalPlayback: false,
        loadExternalTrack: false,
        requiresTrackAvailabilityCheck: true
      },
      performerActionLabel: 'Playable in Sway when licensed',
      audienceClaim: 'Sway playback requires licensed audio',
      riskNote: 'Sway playback needs provenance, license records, and playback audit before this can be enabled.'
    }
  ];
}
