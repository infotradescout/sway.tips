import { useState } from 'react';
import DiscoveryEvidencePage from './DiscoveryEvidencePage';
import AcquisitionQualityPanel from './AcquisitionQualityPanel';

export default function DiscoveryObservatoryPage() {
  const [view, setView] = useState<'quality' | 'evidence'>('quality');
  const [evidenceOpened, setEvidenceOpened] = useState(false);
  return <div className="min-h-screen bg-slate-950 text-slate-100" data-testid="discovery-operator-workspace">
    <nav aria-label="Discovery views" className="mx-auto flex max-w-7xl flex-wrap gap-3 px-4 pt-6">
      <button type="button" aria-pressed={view === 'quality'} onClick={() => setView('quality')} className="min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm aria-pressed:bg-cyan-900">Traffic quality</button>
      <button type="button" aria-pressed={view === 'evidence'} onClick={() => { setEvidenceOpened(true); setView('evidence'); }} className="min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm aria-pressed:bg-cyan-900">Discovery evidence</button>
    </nav>
    <div hidden={view !== 'quality'}><AcquisitionQualityPanel /></div>
    {evidenceOpened ? <section hidden={view !== 'evidence'} aria-label="Separate discovery funnels"><p className="mx-auto max-w-7xl px-4 pt-6 text-sm text-amber-200">Existing evidence totals are unfiltered records, not verified people. Traffic-quality exclusions are shown in the separate Traffic quality view.</p><DiscoveryEvidencePage /></section> : null}
  </div>;
}
