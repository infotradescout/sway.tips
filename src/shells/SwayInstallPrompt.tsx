import React, { useEffect, useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { isMetaInAppBrowser } from '../browserEnvironment';

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
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const INSTALL_DISMISS_KEY = 'sway.installPromptDismissed.v2';

export default function SwayInstallPrompt() {
  const [metaInAppBrowser] = useState(() => isMetaInAppBrowser());
  const [suppressedRoute] = useState(() => {
    if (typeof window === 'undefined') return true;
    const pathname = window.location.pathname;
    // The entire performer surface (setup, live cockpit) is suppressed, not just
    // login/signup: a fixed-position install nag interrupts and visually overlaps
    // the room-setup form before a performer has created a single room, i.e.
    // before they've gotten any value from the app yet.
    return pathname.startsWith('/overlay')
      || pathname.startsWith('/admin')
      || pathname.startsWith('/talent');
  });
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(INSTALL_DISMISS_KEY) === '1';
  });
  const [standalone, setStandalone] = useState(() => isStandaloneMode());
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const updateStandalone = () => setStandalone(isStandaloneMode());
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', updateStandalone);
    window.addEventListener('focus', updateStandalone);
    const settleTimer = window.setTimeout(() => setSettled(true), 900);
    return () => {
      window.clearTimeout(settleTimer);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', updateStandalone);
      window.removeEventListener('focus', updateStandalone);
    };
  }, []);

  if (standalone || dismissed || metaInAppBrowser || suppressedRoute || !settled) return null;

  const canPromptInstall = Boolean(installEvent);
  const showIosHelp = !canPromptInstall && isiPhoneOrIPad();
  if (!canPromptInstall && !showIosHelp) return null;

  const dismiss = () => {
    window.localStorage.setItem(INSTALL_DISMISS_KEY, '1');
    setDismissed(true);
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') {
      setInstallEvent(null);
      setStandalone(true);
    } else if (choice?.outcome === 'dismissed') {
      dismiss();
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[100] flex justify-center px-4">
      <section
        role="dialog"
        aria-label="Install Sway"
        className="pointer-events-auto w-full max-w-[27rem] overflow-hidden rounded-2xl border border-white/12 bg-slate-950/82 text-white shadow-[0_24px_90px_rgba(2,6,23,0.62)] ring-1 ring-fuchsia-300/10 backdrop-blur-2xl"
      >
        <div className="h-px bg-gradient-to-r from-transparent via-fuchsia-300/80 to-cyan-300/70" />
        <div className="flex items-center gap-2.5 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-fuchsia-300/25 bg-gradient-to-br from-fuchsia-500/20 to-cyan-400/15 text-fuchsia-100 shadow-[0_0_28px_rgba(217,70,239,0.24)]">
            <Smartphone className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-fuchsia-200">Install Sway</p>
            <h2 className="mt-0.5 truncate text-[15px] font-black leading-tight text-white">Download Sway</h2>
            <p className="mt-0.5 hidden truncate text-[11px] leading-5 text-slate-300 sm:block">
              {canPromptInstall
                ? 'One tap from your home screen.'
                : 'Share, then Add to Home Screen.'}
            </p>
          </div>

          {canPromptInstall ? (
            <button
              type="button"
              onClick={() => { void install(); }}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-fuchsia-500 to-cyan-400 px-3 py-2 text-xs font-black text-white shadow-[0_0_34px_rgba(217,70,239,0.34)] transition hover:brightness-110"
              aria-label="Install app"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Install
            </button>
          ) : (
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2 text-xs font-black text-white transition hover:border-fuchsia-300/35 hover:bg-white/[0.07]"
            >
              Got it
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-slate-300 transition hover:border-fuchsia-300/30 hover:text-white"
            aria-label="Dismiss install prompt"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  );
}
