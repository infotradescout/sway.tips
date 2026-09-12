import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { AccountHome } from '../../src/components/AccountAccess';
import '../../src/index.css';

const root = createRoot(document.getElementById('root')!);
root.render(new URLSearchParams(window.location.search).has('strict') ? <StrictMode><AccountHome /></StrictMode> : <AccountHome />);
Object.assign(window, { unmountAccountHomeProof: () => root.unmount() });
