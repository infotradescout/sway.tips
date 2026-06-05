import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';

export function mountSwayShell(app: ReactNode) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {app}
    </StrictMode>
  );
}
