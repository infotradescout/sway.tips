import { useContext, useEffect, useRef, useState } from 'react';
import { Download, Link2, Radio } from 'lucide-react';
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
    <section data-sway-source-player-setup="true" aria-label="Connect your playback app" className="mb-5 rounded-2xl border border-fuchsia-500/25 bg-slate-950 p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-fuchsia-300">Playback connection</p>
      <h3 className="mt-1 text-base font-black text-white">Connect the app that plays your music</h3>
      <p className="mt-2 text-xs leading-5 text-slate-300">Your player handles the audio. Sway sends supported controls and shows the player’s reported state. Saved song lists do not connect a player.</p>
      {context.rooms.length > 0 && context.onSelectRoom ? (
        <label className="mt-4 block text-xs font-bold text-slate-200">Room for these controls
          <select aria-label="Room for source playback" value={context.gigId ?? ''} disabled={busy || context.previewMode || accessLost}
            onChange={event => { if (context.rooms.some(room => room.gigId === event.target.value)) context.onSelectRoom?.(event.target.value); }}
            className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white disabled:opacity-50">
            {!selectedRoom ? <option value={context.gigId ?? ''}>{context.gigId ? 'Selected room is not available' : 'Choose a live room'}</option> : null}
            {context.rooms.map(room => <option key={room.gigId} value={room.gigId}>{room.performerName} · {room.gigId.slice(0, 8)}</option>)}
          </select>
        </label>
      ) : null}
      {!canPrepare ? <div role="status" className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
        {context.previewMode ? 'Preview only. No player connections or commands are sent.' : accessLost ? 'Your room access changed. Reload your performer account to check access.' : context.gigId ? 'Waiting for a current, active room. Player setup and controls stay off until this room is confirmed.' : 'Start or select a live room before connecting playback. You can add song lists below without opening a room.'}
        {!context.previewMode ? <a href={accessLost ? INACTIVE_PERFORMER_WORKSPACE_PATHS.connections : INACTIVE_PERFORMER_WORKSPACE_PATHS.room} className="mt-2 block font-bold text-cyan-200 underline">{accessLost ? 'Reload Sources' : 'Open Live Room'}</a> : null}
      </div> : null}
      <div className="mt-4 rounded-xl border border-white/10 bg-slate-900 p-3">
        <h4 className="flex items-center gap-2 text-sm font-black text-white"><Link2 className="h-4 w-4 text-cyan-200" aria-hidden="true" />VirtualDJ</h4>
        <p className="mt-1 text-xs leading-5 text-slate-300">Room-scoped connection for track loading, transport, and source feedback. Audio stays in VirtualDJ.</p>
        <details className="mt-2 text-xs leading-5 text-slate-400"><summary className="min-h-11 cursor-pointer py-2 font-bold text-slate-200">Setup requirements</summary>
          <p>Use VirtualDJ 2023 or later with a Pro license. In VirtualDJ, open Config → Extensions → Effects → Other and install Network Control. Open its settings from the Master effect panel and use a local address with an authentication password.</p>
          <p className="mt-2">The Windows room file runs on your VirtualDJ computer. Keep it private: it contains a short-lived room credential. It does not connect a streaming-service account or grant access to songs.</p>
          <a href="https://virtualdj.com/wiki/NetworkControlPlugin" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-cyan-200 underline">VirtualDJ Network Control instructions</a>
        </details>
        <button type="button" disabled={!canPrepare || busy} onClick={() => setConfirmReplacement(true)} className="mt-2 min-h-11 w-full rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white disabled:opacity-50">{busy ? 'Preparing room connection…' : download ? 'Prepare a fresh connection' : 'Set up VirtualDJ connection'}</button>
        {confirmReplacement && canPrepare ? <div role="group" aria-label="Confirm booth replacement" className="mt-3 rounded-xl border border-amber-400/30 p-3 text-xs leading-5 text-amber-100">
          <p>Preparing this file replaces any existing booth connection for this room. Do this on the computer you intend to use; do not replace a connection during a performance without checking the current booth.</p>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void prepare()} className="min-h-11 rounded-lg bg-amber-300 px-3 font-black text-slate-950">Confirm and prepare room file</button><button type="button" onClick={() => setConfirmReplacement(false)} className="min-h-11 rounded-lg border border-white/20 px-3 font-bold text-white">Cancel</button></div>
        </div> : null}
        {download ? <div className="mt-3 text-xs leading-5 text-slate-200">
          <p role="status" className="font-bold text-cyan-200">Room file prepared — player connection is not confirmed yet.</p>
          <p className="mt-1">Expires {new Date(download.expiresAt).toLocaleTimeString()}. Download and open it on your VirtualDJ computer, then check playback status below.</p>
          <button type="button" onClick={saveFile} disabled={!canPrepare || busy} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/30 px-3 font-black text-cyan-200 disabled:opacity-50"><Download aria-hidden="true" className="h-4 w-4" />Download Windows room file</button>
          {download.command ? <details className="mt-2"><summary className="min-h-11 cursor-pointer py-2 font-bold text-slate-300">Advanced Node bridge</summary><p>For an existing Sway Node bridge installation on your playback computer. Run from the Sway repository directory; this is not a one-click Mac installer. Keep the command private.</p><textarea aria-label="Private room bridge command" readOnly value={download.command} spellCheck={false} className="mt-2 min-h-24 w-full min-w-0 resize-y rounded-lg bg-slate-950 p-2 font-mono text-xs text-slate-200" /></details> : null}
        </div> : null}
        {message ? <p role="alert" className="mt-3 text-xs leading-5 text-amber-100">{message}</p> : null}
      </div>
      <details className="mt-3 rounded-xl border border-white/10 bg-slate-900 p-3 text-xs leading-5 text-slate-300"><summary className="min-h-11 cursor-pointer py-2 text-sm font-black text-white">Serato, rekordbox, Traktor, djay, and MIDI-mapped apps</summary><p>Use a MIDI output mapped to your DJ app. In the controls below, choose MIDI, grant browser access, and explicitly select the output and deck. MIDI sends one-way transport commands; it cannot identify a song or confirm playback. Exact-track loading is unavailable on this route.</p></details>
      <details className="mt-3 text-xs leading-5 text-slate-400"><summary className="min-h-11 cursor-pointer py-2 font-bold text-slate-200">Music service versus playback app</summary><p>A music service and its playback app are separate connections. For example, a TIDAL or SoundCloud song used in a DJ app is controlled through that app’s supported interface, not by remotely controlling the standalone music-service app. Source account access and playback entitlement stay with the player. An exported list is only a fallback.</p></details>
      <button type="button" disabled={!canPrepare || busy} onClick={() => setShowControls(current => !current)} aria-expanded={showControls && canPrepare} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-fuchsia-400/30 px-3 text-sm font-black text-white disabled:opacity-50"><Radio aria-hidden="true" className="h-4 w-4" />{showControls ? 'Hide playback controls' : 'Open playback controls'}</button>
      {showControls && canPrepare ? <div className="mt-3"><PerformerPlaybackController gigId={context.gigId} approvedRequests={context.approvedRequests} previewMode={context.previewMode} /></div> : null}
    </section>
  );
}
