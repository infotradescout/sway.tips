import { useContext, useEffect, useRef, useState } from 'react';
import { Download, Link2, Radio, ArrowUpRight } from 'lucide-react';
import PerformerPlaybackController from './PerformerPlaybackController';
import { SourcePlayerContext, type SourcePlayerContextValue } from '../source-player-context';
import { prepareSourcePlayer, SourcePlayerAccessError, type BoothDownload } from '../source-player-setup';
import { INACTIVE_PERFORMER_WORKSPACE_PATHS } from '../performer-workspace-routing';

export default function PerformerSourcePlayerSetup() {
  const context = useContext(SourcePlayerContext);
  if (!context) return null;
  return <PlayerSetupSession key={JSON.stringify([context.accountId, context.performerId, context.gigId, context.ready, context.previewMode])} context={context} />;
}

function PlayerSetupSession({ context }: { context: SourcePlayerContextValue }) {
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<BoothDownload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const lifetime = useRef<object | null>(null);
  const request = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const canPrepare = context.ready && !context.previewMode && !accessLost && Boolean(context.gigId);

  useEffect(() => {
    const scope = {};
    lifetime.current = scope;
    return () => {
      if (lifetime.current === scope) lifetime.current = null;
      request.current?.abort();
      request.current = null;
      busyRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!download) return;
    const timer = setTimeout(() => {
      setDownload(null);
      setMessage('This room file expired. Prepare a fresh connection when you are ready to reconnect.');
    }, Math.max(0, Date.parse(download.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [download]);

  const prepare = async () => {
    const scope = lifetime.current;
    if (!scope || !canPrepare || !context.gigId || !confirmReplacement || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setConfirmReplacement(false);
    setDownload(null);
    setShowControls(false);
    setMessage(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const file = await prepareSourcePlayer(context.gigId, controller);
      if (lifetime.current !== scope) return;
      setDownload(file);
    } catch (error) {
      if (lifetime.current !== scope) return;
      if (error instanceof SourcePlayerAccessError) {
        setAccessLost(true);
        window.dispatchEvent(new Event('sway:performer-profile-updated'));
      }
      setMessage(error instanceof Error ? error.message : 'Connection preparation failed. Check your booth before preparing another.');
    } finally {
      if (lifetime.current === scope) {
        busyRef.current = false;
        request.current = null;
        setBusy(false);
      }
    }
  };
  const saveFile = () => {
    if (!canPrepare || busyRef.current || !download) return;
    if (Date.parse(download.expiresAt) <= Date.now()) {
      setDownload(null);
      setMessage('The room file expired. Prepare a new connection.');
      return;
    }
    const url = URL.createObjectURL(new Blob([download.bytes], { type: download.contentType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = download.filename;
    link.hidden = true;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1_000); }
  };
  const selectedRoom = context.rooms.find(room => room.gigId === context.gigId);

  return (
    <section data-sway-source-player-setup="true" aria-label="Connect your playback app" className="sway-source-panel sway-player-panel">
      <div className="sway-player-heading">
        <div><p className="sway-source-kicker">Playback</p><h3>Your live setup</h3></div>
        <span className="sway-source-icon"><Radio aria-hidden="true" /></span>
      </div>
      <p className="sway-source-description">Audio stays in your player. Use Sway to send supported controls and see its reported state.</p>
      <div className="sway-player-name">
        <span className="sway-source-icon"><Link2 aria-hidden="true" /></span>
        <div><h4>VirtualDJ</h4><p>Track loading · playback · feedback</p></div>
      </div>
      {context.rooms.length > 0 && context.onSelectRoom ? (
        <label className="sway-player-room">Room for these controls
          <select aria-label="Room for source playback" value={context.gigId ?? ''} disabled={busy || context.previewMode || accessLost}
            onChange={event => { if (context.rooms.some(room => room.gigId === event.target.value)) context.onSelectRoom?.(event.target.value); }}
            className="sway-source-field">
            {!selectedRoom ? <option value={context.gigId ?? ''}>{context.gigId ? 'Selected room is not available' : 'Choose a live room'}</option> : null}
            {context.rooms.map(room => <option key={room.gigId} value={room.gigId}>{room.performerName} · {room.gigId.slice(0, 8)}</option>)}
          </select>
        </label>
      ) : null}
      {!canPrepare ? <div role="status" className="sway-player-availability">
        <p>{context.previewMode ? 'Preview only. No player connections or commands are sent.' : accessLost ? 'Your room access changed. Reload your performer account to check access.' : context.gigId ? 'Waiting for a current, active room. Player setup and controls stay off until this room is confirmed.' : 'Start a live room to connect playback. Your saved music stays ready between rooms.'}</p>
        {!context.previewMode ? <a href={accessLost ? INACTIVE_PERFORMER_WORKSPACE_PATHS.connections : INACTIVE_PERFORMER_WORKSPACE_PATHS.room}>{accessLost ? 'Reload Sources' : 'Open Live Room'}<ArrowUpRight aria-hidden="true" className="ml-1 h-3.5 w-3.5" /></a> : null}
      </div> : null}
      <button type="button" disabled={!canPrepare || busy} onClick={() => setConfirmReplacement(true)} className="sway-source-button sway-source-button--primary sway-source-button--wide">{busy ? 'Preparing room connection…' : download ? 'Prepare a fresh connection' : 'Set up VirtualDJ connection'}</button>
      {confirmReplacement && canPrepare ? <div role="group" aria-label="Confirm booth replacement" className="sway-player-confirm">
        <p>Preparing this file replaces any existing booth connection for this room. Do this on the computer you intend to use; do not replace a connection during a performance without checking the current booth.</p>
        <div><button type="button" onClick={() => void prepare()} className="sway-source-button">Confirm and prepare room file</button><button type="button" onClick={() => setConfirmReplacement(false)} className="sway-source-button">Cancel</button></div>
      </div> : null}
      {download ? <div className="sway-player-download">
        <p role="status">Room file prepared — player connection is not confirmed yet.</p>
        <p>Expires {new Date(download.expiresAt).toLocaleTimeString()}. Download and open it on your VirtualDJ computer, then check playback status below.</p>
        <button type="button" onClick={saveFile} disabled={!canPrepare || busy} className="sway-source-button sway-source-button--wide"><Download aria-hidden="true" />Download Windows room file</button>
        {download.command ? <details className="sway-source-disclosure"><summary>Advanced Node bridge</summary><p>For an existing Sway Node bridge installation on your playback computer. Run from the Sway repository directory; this is not a one-click Mac installer. Keep the command private.</p><textarea aria-label="Private room bridge command" readOnly value={download.command} spellCheck={false} className="sway-source-field mt-3 min-h-24 resize-y font-mono text-xs" /></details> : null}
      </div> : null}
      {message ? <p role="alert" className="sway-source-feedback">{message}</p> : null}
      <button type="button" disabled={!canPrepare || busy} onClick={() => setShowControls(current => !current)} aria-expanded={showControls && canPrepare} className="sway-source-button sway-source-button--wide"><Radio aria-hidden="true" />{showControls ? 'Hide playback controls' : 'Open playback controls'}</button>
      {showControls && canPrepare ? <div className="sway-player-controls"><PerformerPlaybackController gigId={context.gigId} approvedRequests={context.approvedRequests} previewMode={context.previewMode} /></div> : null}
      <div className="sway-player-extras">
        <details className="sway-source-disclosure"><summary>Setup requirements</summary>
          <p>Use VirtualDJ 2023 or later with a Pro license. In VirtualDJ, open Config → Extensions → Effects → Other and install Network Control. Open its settings from the Master effect panel and use a local address with an authentication password.</p>
          <p>The Windows room file runs on your VirtualDJ computer. Keep it private: it contains a short-lived room credential. It does not connect a streaming-service account or grant access to songs.</p>
          <a href="https://virtualdj.com/wiki/NetworkControlPlugin" target="_blank" rel="noopener noreferrer">VirtualDJ Network Control instructions</a>
        </details>
        <details className="sway-source-disclosure"><summary>Serato, rekordbox, Traktor, djay, and MIDI-mapped apps</summary><p>Use a MIDI output mapped to your DJ app. In the controls above, choose MIDI, grant browser access, and explicitly select the output and deck. MIDI sends one-way transport commands; it cannot identify a song or confirm playback. Exact-track loading is unavailable on this route.</p></details>
        <details className="sway-source-disclosure"><summary>Music service versus playback app</summary><p>A music service and its playback app are separate connections. For example, a TIDAL or SoundCloud song used in a DJ app is controlled through that app’s supported interface, not by remotely controlling the standalone music-service app. Source account access and playback entitlement stay with the player. An exported list is only a fallback.</p></details>
      </div>
    </section>
  );
}
