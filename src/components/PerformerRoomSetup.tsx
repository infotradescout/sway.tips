import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Play } from 'lucide-react';

export type PerformerRoomSetupData = {
  talentName: string;
  talentRole: 'DJ' | 'Performer';
  feeType: 'talent' | 'patron';
  minimumTip: number;
  paymentsEnabled: boolean;
  searchScope: 'library' | 'catalog';
};

const steps = ['Pricing', 'Requests', 'Review', 'Start'];

export default function PerformerRoomSetup({
  performerName,
  talentRole,
  performerEmailVerified,
  onStartSession
}: {
  performerName: string;
  talentRole: 'DJ' | 'Performer';
  performerEmailVerified: boolean;
  onStartSession: (data: PerformerRoomSetupData) => void;
}) {
  const [step, setStep] = useState(0);
  const [paymentsEnabled, setPaymentsEnabled] = useState(true);
  const [minimumTip, setMinimumTip] = useState(5);
  const [feeType, setFeeType] = useState<'talent' | 'patron'>('patron');
  const [searchScope, setSearchScope] = useState<'library' | 'catalog'>('library');

  const pricingSummary = paymentsEnabled
    ? `Paid · $${minimumTip} minimum · ${feeType === 'patron' ? 'customer pays fee' : 'you absorb fee'}`
    : 'Free requests · direct tips stay paid';
  const requestSummary = searchScope === 'library'
    ? 'Customers request from your synced library'
    : 'Customers can type any request; you approve or deny it';

  const submit = () => onStartSession({
    talentName: performerName,
    talentRole,
    feeType,
    minimumTip: Math.max(5, minimumTip),
    paymentsEnabled,
    searchScope
  });

  return (
    <section data-sway-performer-room-setup="true" className="mx-auto w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-900 p-4 shadow-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Tonight&apos;s room</p>
          <h2 className="mt-1 font-display text-xl font-black uppercase text-white">{steps[step]}</h2>
        </div>
        <p className="font-mono text-[10px] font-black uppercase tracking-widest text-slate-400">Step {step + 1} of 4</p>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-1" aria-label="Room setup progress">
        {steps.map((label, index) => (
          <div key={label} className="min-w-0">
            <div className={`h-1.5 rounded-full ${index <= step ? 'bg-fuchsia-500' : 'bg-slate-800'}`} />
            <p className={`mt-1 truncate text-center text-[8px] font-bold uppercase ${index === step ? 'text-white' : 'text-slate-600'}`}>{label}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 min-h-[18rem]">
        {step === 0 ? (
          <div className="space-y-4">
            <p className="text-xs font-bold text-cyan-300">{performerName}</p>
            <p className="text-sm text-slate-400">Should song requests cost money tonight?</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setPaymentsEnabled(true)} className={`rounded-2xl border p-4 text-left ${paymentsEnabled ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}><span className="font-black text-white">Paid requests</span><span className="mt-2 block text-xs text-slate-400">Requests and boosts start at ${minimumTip}. Direct tips remain available.</span></button>
              <button type="button" onClick={() => setPaymentsEnabled(false)} className={`rounded-2xl border p-4 text-left ${!paymentsEnabled ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}><span className="font-black text-white">Free requests</span><span className="mt-2 block text-xs text-slate-400">Requests and upvotes are free. Direct tips remain paid.</span></button>
            </div>
            {paymentsEnabled ? (
              <div className="rounded-xl border border-white/10 bg-slate-950 p-4">
                <div className="flex justify-between text-sm font-bold text-white"><span>Minimum</span><span>${minimumTip}</span></div>
                <input aria-label="Minimum request amount" type="range" min="5" max="25" value={minimumTip} onChange={(event) => setMinimumTip(Number(event.target.value))} className="mt-3 w-full accent-fuchsia-500" />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setFeeType('patron')} className={`rounded-lg px-3 py-2 text-xs font-bold ${feeType === 'patron' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>Customer pays fee</button>
                  <button type="button" onClick={() => setFeeType('talent')} className={`rounded-lg px-3 py-2 text-xs font-bold ${feeType === 'talent' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>I absorb fee</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : step === 1 ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">What can customers ask for?</p>
            <button type="button" onClick={() => setSearchScope('library')} className={`w-full rounded-2xl border p-5 text-left ${searchScope === 'library' ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}><span className="font-black text-white">My synced library</span><span className="mt-2 block text-xs text-slate-400">Only show tracks you have synced to Sway.</span></button>
            <button type="button" onClick={() => setSearchScope('catalog')} className={`w-full rounded-2xl border p-5 text-left ${searchScope === 'catalog' ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}><span className="font-black text-white">Open requests</span><span className="mt-2 block text-xs text-slate-400">Customers type anything. Nothing enters the approved queue until you allow it.</span></button>
          </div>
        ) : step === 2 ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">Check the exact rules before the room goes live.</p>
            {[['Host', performerName], ['Pricing', pricingSummary], ['Requests', requestSummary]].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-white/10 bg-slate-950 p-4"><p className="text-[9px] font-black uppercase tracking-widest text-cyan-300">{label}</p><p className="mt-1 text-sm font-bold text-white">{value}</p></div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-[18rem] flex-col items-center justify-center text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300"><Check className="h-7 w-7" /></span>
            <h3 className="mt-4 font-display text-2xl font-black uppercase text-white">Ready to go live</h3>
            <p className="mt-2 max-w-sm text-sm text-slate-400">Create the room, then Sway opens your live queue and generates the customer link and QR.</p>
            {!performerEmailVerified ? <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">Verify your email before creating a room.</p> : null}
          </div>
        )}
      </div>

      <div className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-3">
        <button type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-bold text-slate-300 disabled:opacity-30"><ArrowLeft className="h-4 w-4" /> Back</button>
        {step < 3 ? (
          <button type="button" onClick={() => setStep((current) => Math.min(3, current + 1))} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white">Next <ArrowRight className="h-4 w-4" /></button>
        ) : (
          <button type="button" onClick={submit} disabled={!performerEmailVerified} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-black text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"><Play className="h-4 w-4" /> Create room</button>
        )}
      </div>
    </section>
  );
}
