import { useContext } from 'react';
import { SourcePlayerContext } from '../source-player-context';
import PerformerSpotifyConnection from './PerformerSpotifyConnection';
import NativePlayerConnections from './NativePlayerConnections';

// Preserve the account integration while adding a separate native-player lane.
// A connected music library is not implicitly a playback target for another app.
export default function PerformerDirectMusicConnection() {
  const context = useContext(SourcePlayerContext);
  if (!context?.accountId || !context.performerId) return null;
  const scope = [context.accountId, context.performerId, context.previewMode].join(':');
  return <div className="space-y-4" key={scope}>
    <PerformerSpotifyConnection />
    <NativePlayerConnections preview={context.previewMode} />
  </div>;
}
