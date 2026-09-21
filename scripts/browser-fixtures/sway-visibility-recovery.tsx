import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PerformerVisibilityControl } from '../../src/components/PerformerVisibilityControl';
import '../../src/index.css';

function Fixture() {
  const [mounted, setMounted] = useState(true);
  const [preview, setPreview] = useState(false);
  return <main className="mx-auto min-h-screen w-full max-w-3xl bg-slate-950 p-3 text-white">
    <div className="mb-4 flex flex-wrap gap-3">
      <button type="button" onClick={() => setMounted(value => !value)}>Toggle fixture mount</button>
      <button type="button" onClick={() => setPreview(value => !value)}>Toggle fixture preview</button>
    </div>
    <label className="mb-4 block">Surrounding unsaved draft<input className="block w-full bg-slate-900" defaultValue="Keep my other profile edits" /></label>
    {mounted ? <PerformerVisibilityControl previewMode={preview} /> : <p>Visibility unmounted</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
