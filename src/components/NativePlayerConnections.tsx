import { useEffect, useRef, useState } from 'react';
import { NativePlayerClient, type NativeConnection, type NativeState } from '../native-player-client.mjs';

const actionLabels: Record<string, string> = { play: 'Play', pause: 'Pause', stop: 'Stop', cue: 'Cue', next: 'Next', previous: 'Previous' };
type Session = { client: NativePlayerClient; lifetime: AbortController };

export default function NativePlayerConnections({ preview }: { preview: boolean }) {
  const [key, setKey] = useState('');
  const [connections, setConnections] = useState<NativeConnection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [state, setState] = useState<NativeState | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  const [uncertainTargets, setUncertainTargets] = useState<Record<string, boolean>>({});
  const [reviewChecked, setReviewChecked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const session = useRef<Session | null>(null), sending = useRef(false), sequence = useRef(0);
  const mounted = useRef(false), selectedRef = useRef('');
  selectedRef.current = selectedId;
  const selected = connections.find(connection => connection.id === selectedId) ?? null;
  const uncertainLocal = selected ? Boolean(uncertainTargets[selected.targetKey]) : false;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; session.current?.lifetime.abort(); session.current = null; }; }, []);
  const current = (value: Session) => mounted.current && session.current === value && !value.lifetime.signal.aborted;
  const applyConnections = (items: NativeConnection[]) => {
    setConnections(items);
    // A disconnected output is never silently replaced with another program.
    setSelectedId(id => items.some(item => item.id === id) ? id : '');
  };
  const pair = async () => {
    if (preview || sending.current) return;
    session.current?.lifetime.abort(); sequence.current++;
    setState(null); setConnections([]); setSelectedId(''); setPaired(false);
    const lifetime = new AbortController(); let value: Session;
    try { value = { client: new NativePlayerClient({ pairingKey: key.trim(), signal: lifetime.signal }), lifetime }; }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Enter your private pairing key.'); return; }
    session.current = value; sending.current = true; setBusy(true);
    try {
      const items = await value.client.list();
      if (!current(value)) return;
      applyConnections(items); setPaired(true); setKey(''); setUncertainTargets({}); setReviewChecked(false);
      setMessage('Computer linked. Choose the intended program. No playback command was sent.');
    } catch (error) {
      if (current(value)) { setMessage(error instanceof Error ? error.message : 'Local player host unavailable.'); lifetime.abort(); session.current = null; }
    } finally { if (mounted.current) { sending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const value = session.current;
    if (!value || !selected || preview) { setState(null); return; }
    const revision = ++sequence.current; let reading = false;
    setState(null); setReviewChecked(false);
    const read = async () => {
      if (reading || !current(value)) return;
      reading = true;
      try {
        const items = await value.client.list();
        if (!current(value) || sequence.current !== revision) return;
        applyConnections(items);
        const target = items.find(item => item.id === selected.id);
        if (!target || target.revision !== selected.revision) { setState(null); return; }
        const next = await value.client.state(target);
        if (current(value) && sequence.current === revision && selectedRef.current === selected.id) {
          setState(next); setMessage(old => old.startsWith('Player state is unavailable.') ? 'Player state refreshed. No command was resent.' : old);
        }
      } catch {
        if (current(value) && sequence.current === revision) { setState(null); setMessage('Player state is unavailable. Controls are paused; refresh or reconnect without resending commands.'); }
      } finally { reading = false; }
    };
    void read();
    const poll = window.setInterval(() => void read(), 2000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { sequence.current++; window.clearInterval(poll); window.clearInterval(clock); };
  }, [selected?.id, selected?.revision, preview, paired]);
  const refresh = async () => {
    const value = session.current; if (!value || !current(value) || sending.current || preview) return;
    sending.current = true; setBusy(true);
    try {
      const items = await value.client.list(); if (!current(value)) return;
      applyConnections(items);
      const target = items.find(item => item.id === selectedRef.current);
      if (target) { const next = await value.client.state(target); if (current(value) && selectedRef.current === target.id) setState(next); }
      setMessage('Connection information refreshed. No playback command was sent.');
    } catch (error) { if (current(value)) { setState(null); setMessage(error instanceof Error ? error.message : 'Refresh unavailable.'); } }
    finally { if (current(value)) { sending.current = false; setBusy(false); } }
  };
  const command = async (action: string) => {
    const value = session.current, target = selected;
    if (!value || !target || !current(value) || sending.current || preview || target.uncertain || uncertainLocal
      || !state || Date.now() - Date.parse(state.observedAt) > 15000) return;
    const id = crypto.randomUUID(); sending.current = true; setBusy(true);
    try {
      const result = await value.client.command(target, { id, action });
      if (!current(value) || selectedRef.current !== target.id) return;
      setUncertainTargets(old => ({ ...old, [target.targetKey]: result.uncertain }));
      setMessage(result.uncertain ? `${actionLabels[action]} delivery is uncertain. Check the original player; this command will not replay.`
        : `${actionLabels[action]} acknowledged by ${target.label}. Playback state below is observed separately.`);
      const items = await value.client.list(); if (!current(value)) return; applyConnections(items);
      const next = await value.client.state(target); if (current(value) && selectedRef.current === target.id) setState(next);
    } catch (error) {
      if (!current(value)) return;
      setUncertainTargets(old => ({ ...old, [target.targetKey]: true })); setState(null);
      setMessage('Command confirmation was lost. Check the original player. Refreshing or reconnecting will not resend it.');
      try { const items = await value.client.list(); if (current(value)) applyConnections(items); } catch { /* Keep the conservative uncertainty display. */ }
    } finally { if (current(value)) { sending.current = false; setBusy(false); } }
  };
  const review = async () => {
    const value = session.current, target = selected;
    if (!value || !target || !current(value) || sending.current || !reviewChecked || preview) return;
    sending.current = true; setBusy(true);
    try {
      for (const item of target.pendingReview) await value.client.review(target, item.id);
      // Explicit operator review may clear a local lost-response warning even
      // when the host confirms that no unknown execution remains in its journal.
      const items = await value.client.list(); if (!current(value)) return;
      applyConnections(items);
      if (!items.find(item => item.id === target.id)?.uncertain) setUncertainTargets(old => ({ ...old, [target.targetKey]: false }));
      setReviewChecked(false); setMessage('Review saved. The old command was not replayed. A new action requires a new button press.');
    } catch (error) { if (current(value)) setMessage(error instanceof Error ? error.message : 'Review could not be saved.'); }
    finally { if (current(value)) { sending.current = false; setBusy(false); } }
  };
  const reconnect = async () => {
    const value = session.current, target = selected;
    if (!value || !target || !current(value) || sending.current || preview) return;
    sending.current = true; setBusy(true);
    try {
      const next = await value.client.reconnect(target); if (!current(value)) return;
      setConnections(items => items.map(item => item.id === next.id ? next : item)); setState(null);
      setMessage('Reconnected to the same player. Unknown commands remain held and were not resent.');
    } catch (error) { if (current(value)) { setState(null); setMessage(error instanceof Error ? error.message : 'Reconnect unavailable.'); } }
    finally { if (current(value)) { sending.current = false; setBusy(false); } }
  };
  const disconnect = () => {
    if (sending.current) return;
    session.current?.lifetime.abort(); session.current = null; sequence.current++;
    setPaired(false); setConnections([]); setSelectedId(''); setState(null); setKey(''); setReviewChecked(false);
    setMessage('This browser forgot its pairing key. The player was not stopped or restarted; its durable command history remains on the computer.');
  };
  const fresh = state && now - Date.parse(state.observedAt) <= 15000;
  const canCommand = paired && Boolean(selected) && Boolean(fresh) && !busy && !preview && !selected?.uncertain && !uncertainLocal;
  return <section data-sway-native-players="true" aria-label="Local player connections" className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
    <h3 className="text-lg font-semibold text-white">Player programs on this computer</h3>
    <p className="text-sm text-slate-300">Link configured VLC, mpv or VirtualDJ players through the Sway player host. Audio stays in the original program. Account libraries and MIDI connections remain separate.</p>
    <p className="text-xs text-slate-400">Developer preview: the Node-based player host must already be running on this computer. This is not yet a one-click desktop installer.</p>
    {!paired ? <form onSubmit={event => { event.preventDefault(); void pair(); }} className="flex flex-wrap gap-2">
      <label className="min-w-0 flex-1 text-sm text-slate-200">Private player pairing key
        <input type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" disabled={preview || busy}
          className="mt-1 block min-h-11 w-full rounded-lg border border-white/20 bg-slate-900 p-2" />
      </label>
      <button type="submit" disabled={preview || busy || !key.trim()} className="min-h-11 rounded-lg bg-cyan-400 px-4 font-semibold text-slate-950 disabled:opacity-40">Link player computer</button>
    </form> : <>
      <label className="block text-sm text-slate-200">Configured player target
        <select aria-label="Configured player target" value={selectedId} disabled={busy} onChange={event => { setSelectedId(event.target.value); setState(null); setReviewChecked(false); }}
          className="mt-1 min-h-11 w-full rounded-lg border border-white/20 bg-slate-900 p-2">
          <option value="">Choose a player; no automatic selection</option>
          {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · Deck {connection.deck} · {connection.id.slice(0, 8)}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {selected?.actions.map(action => <button key={action} type="button" aria-label={`${actionLabels[action]} selected local player`} disabled={!canCommand}
          onClick={event => { if (event.detail <= 1) void command(action); }} onKeyDown={event => { if (event.repeat) event.preventDefault(); }} className="min-h-11 rounded-lg border border-white/20 px-3 text-white disabled:opacity-40">{actionLabels[action]}</button>)}
      </div>
      <p role="status" className="break-words text-sm text-slate-200">{state && fresh ? `${state.trackTitle || selected?.label || 'Player'} — ${state.playing ? 'Playing' : 'Not playing'} (observed from the original player)` : 'No current original-player state. Playback controls are paused.'}</p>
      {selected && (selected.uncertain || uncertainLocal) ? <div className="space-y-2 rounded-lg border border-amber-400/50 p-3 text-sm text-amber-100">
        <p>Uncertain delivery is held. Reconnect cannot authorize a repeat.</p>
        {selected.pendingReview.map(item => <p key={item.id}>{actionLabels[item.action]} · {item.id.slice(0, 8)} · {new Date(item.finishedAt).toLocaleTimeString()}</p>)}
        <label className="flex items-center gap-2"><input type="checkbox" checked={reviewChecked} onChange={event => setReviewChecked(event.target.checked)} disabled={busy} />I checked the original player and understand the old command will not be replayed.</label>
        <button type="button" onClick={() => void review()} disabled={preview || busy || !reviewChecked} className="min-h-11 rounded border border-amber-300/50 px-3 disabled:opacity-40">Save review; allow a new action</button>
      </div> : null}
      <div className="flex flex-wrap gap-2 text-sm text-slate-200">
        <button type="button" onClick={() => void refresh()} disabled={preview || busy} className="min-h-11 rounded border border-white/20 px-3">Refresh local player state</button>
        <button type="button" onClick={() => void reconnect()} disabled={preview || busy || !selected} className="min-h-11 rounded border border-white/20 px-3 disabled:opacity-40">Reconnect selected player</button>
        <button type="button" onClick={disconnect} disabled={busy} className="min-h-11 rounded border border-white/20 px-3">Forget this browser pairing</button>
      </div>
    </>}
    {preview ? <p className="text-sm text-amber-200">Preview mode: pairing and playback are disabled.</p> : null}
    {message ? <p role="status" className="text-sm text-slate-300">{message}</p> : null}
  </section>;
}
