import { useEffect, useRef, useState } from 'react';

type Fields = Partial<Record<'bio' | 'headline' | 'city', string | null>>;
type Binding = { id: string; provider: string; accountId: string; businessId: string; subjectId?: string; displayName?: string };
type Proposal = { id: string; status?: string | null; proposal: { scope: { provider: string; accountId: string; businessId: string; subjectId: string }; direction: string; fields: Fields; payloadDigest: string; expectedNativeVersion: string; businessBindingRevision: string | number } };
type Snapshot = { nativeVersion: string; fields: Fields; bindings: Binding[]; proposals: Proposal[]; providerPublishingAvailable?: boolean };
export type PerformerReverseOsmosisProps = { performerHandle?: string | null; profileRevision?: string | number; onApplied?: () => void };

export default function PerformerReverseOsmosis(props: PerformerReverseOsmosisProps) {
  return <ScopedSync key={JSON.stringify([props.performerHandle, props.profileRevision])} {...props} />;
}

function ScopedSync({ performerHandle, onApplied }: PerformerReverseOsmosisProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [message, setMessage] = useState('Loading business account review…');
  const scope = useRef({ active: true, controller: new AbortController(), pending: false });
  const base = '/api/talent/profile/sync';
  async function request(path: string, body?: unknown) {
    const operation = scope.current;
    const scopedPath = performerHandle ? `${path}?handle=${encodeURIComponent(performerHandle)}` : path;
    const response = await fetch(scopedPath, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal: operation.controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!operation.active) throw new Error('Inactive profile');
    if (response.status === 401 || response.status === 403) {
      setSnapshot(null); setSelected(null); setConfirmed(false); setBlocked(true);
      setRecoveryId(null);
      throw new Error('Access changed. Sign in again to review this profile.');
    }
    if (!response.ok) throw new Error('The request could not be confirmed. Review is required before any further action.');
    return response.json();
  }
  async function load() {
    setBusy(true); setSelected(null); setConfirmed(false);
    try {
      const data = await request(base);
      if (!scope.current.active) return;
      if (!Array.isArray(data.bindings) || !Array.isArray(data.proposals) || typeof data.nativeVersion !== 'string') throw new Error('Business account review is unavailable.');
      setSnapshot(data); setMessage('');
    } catch (error) { if (scope.current.active) setMessage(error instanceof Error ? error.message : 'Review unavailable.'); }
    finally { if (scope.current.active) setBusy(false); }
  }
  useEffect(() => {
    const operation = { active: true, controller: new AbortController(), pending: false };
    scope.current = operation;
    if (performerHandle) void load(); else { setBusy(false); setMessage('Select a performer profile to review business account changes.'); }
    return () => { operation.active = false; operation.controller.abort(); };
    // Each performer/profile revision has an isolated operation scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function preview(bindingId: string) {
    if (busy || blocked || scope.current.pending) return;
    scope.current.pending = true; setBusy(true); setSelected(null); setConfirmed(false);
    try {
      const data = await request(`${base}/preview`, { bindingId });
      if (!scope.current.active) return;
      if (!data.id || !data.proposal?.payloadDigest) throw new Error('Preview could not be confirmed.');
      setSelected(data); setMessage('Review the exact account and changes below.');
    } catch (error) { if (scope.current.active) setMessage(error instanceof Error ? error.message : 'Preview unavailable.'); }
    finally { if (scope.current.active) { setBusy(false); scope.current.pending = false; } }
  }
  async function approveAndRun() {
    if (!selected || !confirmed || busy || blocked || scope.current.pending) return;
    const reviewed = selected;
    setRecoveryId(reviewed.id);
    scope.current.pending = true; setBusy(true); setConfirmed(false); setBlocked(true);
    try {
      const { payloadDigest, expectedNativeVersion, businessBindingRevision } = reviewed.proposal;
      const approval = await request(`${base}/${encodeURIComponent(reviewed.id)}/approve`, { confirmed: true, payloadDigest, expectedNativeVersion, businessBindingRevision });
      if (!scope.current.active) return;
      const approvalId = approval.approval?.approvalId;
      if (!approvalId) throw new Error('Approval could not be confirmed.');
      const result = await request(`${base}/${encodeURIComponent(reviewed.id)}/run`, { approvalId });
      if (!scope.current.active) return;
      const status = result.outcome?.status;
      if (status === 'completed') {
        setMessage(reviewed.proposal.direction === 'social-to-native' || reviewed.proposal.direction === 'social_to_native' ? 'Changes applied to the Sway profile.' : 'The server confirmed completion for this reviewed business account.');
        setSelected(null); setRecoveryId(null);
        if (reviewed.proposal.direction === 'social-to-native' || reviewed.proposal.direction === 'social_to_native') onApplied?.();
      }
      else setMessage('Changes are held for review. No publication is confirmed. Do not retry this action automatically.');
    } catch (error) { if (scope.current.active) setMessage(error instanceof Error && error.message.startsWith('Access changed') ? error.message : 'The outcome is unconfirmed. Changes are held for review; do not repeat approval or run.'); }
    finally { if (scope.current.active) { setBusy(false); scope.current.pending = false; } }
  }
  async function checkOutcome(saved?: Proposal) {
    const id = saved?.id ?? recoveryId;
    if (!id || busy) return;
    setBusy(true);
    try {
      const result = await request(`${base}/${encodeURIComponent(id)}/outcome`);
      if (!scope.current.active) return;
      if (result.outcome?.status === 'completed') {
        const direction = saved?.proposal.direction ?? selected?.proposal.direction;
        const inbound = direction === 'social-to-native' || direction === 'social_to_native';
        setMessage(inbound ? 'Changes applied to the Sway profile.' : 'The server confirmed completion for this reviewed business account.'); setSelected(null); setRecoveryId(null); if (inbound) onApplied?.();
      }
      else setMessage('Changes remain held or unconfirmed. Review is required; no publication is confirmed.');
    } catch { if (scope.current.active) setMessage('Outcome is still unavailable. Do not repeat approval or run.'); }
    finally { if (scope.current.active) setBusy(false); }
  }
  const button = 'min-h-12 rounded-xl border border-white/20 px-4 py-3 text-sm disabled:opacity-50';
  return <section data-sway-reverse-osmosis="true" className="min-w-0 space-y-4 rounded-2xl border border-white/10 bg-slate-950 p-4 text-white" style={{ overflowWrap: 'anywhere' }} aria-label="Business account profile sync">
    <h3 className="text-lg font-semibold">Business account profile sync</h3>
    <p className="text-sm text-slate-300">Review changes between your saved Sway profile and an independently verified business account.</p>
    {message && <p role="status" className="text-sm">{message}</p>}
    {snapshot?.providerPublishingAvailable === false && <p className="text-sm">Publishing to business accounts is unavailable. No publication will occur.</p>}
    {recoveryId && <button type="button" className={button} disabled={busy} onClick={() => void checkOutcome()}>Check outcome</button>}
    {snapshot && snapshot.bindings.length === 0 && <p className="text-sm">A verified business account bound to this profile is needed. You can continue editing your Sway profile manually.</p>}
    {snapshot?.bindings.map(binding => <div key={binding.id} className="space-y-2 rounded-xl border border-white/10 p-3">
      <p className="text-sm">{binding.displayName || binding.accountId} · {binding.provider}<br />Business: {binding.businessId} · Account: {binding.accountId}</p>
      <button type="button" className={button} disabled={busy || blocked} onClick={() => void preview(binding.id)}>Preview saved profile changes</button>
    </div>)}
    {snapshot?.proposals.map(item => <div key={item.id} className="space-y-2 rounded-xl border border-white/10 p-3">
      <p className="text-sm">{item.proposal.scope.provider} · {item.proposal.scope.accountId} · {item.status ?? 'pending'}</p>
      {item.status == null || item.status === 'proposed' || item.status === 'pending'
        ? <button type="button" className={button} disabled={busy || blocked} onClick={() => { setSelected(item); setConfirmed(false); setMessage('Review the exact account and changes below.'); }}>Review account changes</button>
        : <button type="button" className={button} disabled={busy} onClick={() => void checkOutcome(item)}>Check saved outcome</button>}
    </div>)}
    {selected && <div className="space-y-3 rounded-xl border border-cyan-400/30 p-3">
      <p className="text-sm">Provider: {selected.proposal.scope.provider}<br />Business: {selected.proposal.scope.businessId}<br />Account: {selected.proposal.scope.accountId}<br />Sway profile: {performerHandle} ({selected.proposal.scope.subjectId})<br />Direction: {selected.proposal.direction}</p>
      <dl className="space-y-2 text-sm">{Object.entries(selected.proposal.fields).map(([field, value]) => <div key={field}><dt className="font-semibold">{field}</dt><dd>Current Sway value: {snapshot?.fields[field as keyof Fields] ?? '(empty)'}</dd><dd>Proposed value: {value ?? '(empty)'}</dd></div>)}</dl>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || blocked} onChange={event => setConfirmed(event.target.checked)} />I reviewed this exact business account, profile and changes.</label>
      <button type="button" className={button} disabled={!confirmed || busy || blocked} onClick={() => void approveAndRun()}>Approve and run reviewed changes</button>
    </div>}
  </section>;
}
