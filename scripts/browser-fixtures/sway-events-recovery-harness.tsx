import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PerformerEventsManager from '../../src/components/PerformerEventsManager';
import '../../src/index.css';

// Local browser fixture only. No account, payment or backend authority is mocked
// into the production application. The browser runner supplies loopback replies.
function EventsRecoveryHarness() {
  const [preview, setPreview] = useState(false);
  return <main className="min-h-screen p-2 sm:p-4">
    <button type="button" className="mb-3 min-h-11 rounded border px-3" onClick={() => setPreview((value) => !value)}>
      Toggle fixture preview
    </button>
    <PerformerEventsManager previewMode={preview} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><EventsRecoveryHarness /></React.StrictMode>);
