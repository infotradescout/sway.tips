import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { installViewportEnvironment } from '../browserEnvironment';
import '../index.css';
import SwayInstallPrompt from '../shells/SwayInstallPrompt';

function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
      void registration.update();
    }).catch(() => {});
  });
}

export function mountSwayShell(app: ReactNode) {
  installViewportEnvironment();
  registerServiceWorker();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <>
        {app}
        <SwayInstallPrompt />
      </>
    </StrictMode>
  );
}
