import React, { useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || (typeof navigator !== 'undefined' && 'standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

function isiPhoneOrIPad() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function SwayInstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('sway.installPromptDismissed') === '1';
  });
  const [standalone, setStandalone] = useState(() => isStandaloneMode());

  useEffect(() => {
    const updateStandalone = () => setStandalone(isStandaloneMode());
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', updateStandalone);
    window.addEventListener('focus', updateStandalone);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', updateStandalone);
      window.removeEventListener('focus', updateStandalone);
    };
  }, []);

  if (standalone || dismissed) return null;

  const canPromptInstall = Boolean(installEvent);
  const showIosHelp = !canPromptInstall && isiPhoneOrIPad();

  const dismiss = () => {
    window.localStorage.setItem('sway.installPromptDismissed', '1');
    setDismissed(true);
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') {
      setInstallEvent(null);
      setStandalone(true);
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-emerald-500/20 bg-slate-950/95 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.26em] text-emerald-300">Install Sway</p>
            <p className="mt-1 text-sm font-semibold text-white">Keep Sway on your home screen like an app.</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              {canPromptInstall
                ? 'Open rooms faster, rejoin your performer flow, and launch Sway without hunting for a browser tab.'
                : showIosHelp
                  ? 'On iPhone or iPad, tap Share in Safari, then tap Add to Home Screen.'
                  : "This browser doesn't support one-tap installs yet. Look for \"Install app\" or \"Add to Home Screen\" in your browser's menu."}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-white"
          >
            Dismiss
          </button>
        </div>
        {canPromptInstall ? (
          <button
            type="button"
            onClick={() => { void install(); }}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-emerald-400 px-4 py-3 text-sm font-black text-slate-950 transition hover:bg-emerald-300"
          >
            Install app
          </button>
        ) : null}
      </div>
    </div>
  );
}
