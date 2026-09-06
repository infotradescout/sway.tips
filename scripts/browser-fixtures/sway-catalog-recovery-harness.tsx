import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PerformerAudioFiles from '../../src/components/PerformerAudioFiles';
import '../../src/index.css';
function Harness() {
  const [mounted, setMounted] = useState(true);
  return <main className="min-h-screen min-w-0 bg-slate-950 p-2 text-white">
    <button type="button" onClick={() => setMounted(value => !value)}>Toggle fixture mount</button>
    {mounted ? <PerformerAudioFiles /> : <p>Catalog unmounted</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
