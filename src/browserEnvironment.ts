const META_IN_APP_BROWSER_PATTERN = /FBAN|FBAV|FB_IAB|FB4A|FBIOS|MessengerForiOS|FB_IAB\/MESSENGER/i;

export function isMetaInAppBrowser(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  return META_IN_APP_BROWSER_PATTERN.test(userAgent);
}

export function installViewportEnvironment() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const root = document.documentElement;
  const updateViewport = () => {
    const viewport = window.visualViewport;
    const width = Math.max(1, Math.round(viewport?.width ?? window.innerWidth ?? root.clientWidth));
    const height = Math.max(1, Math.round(viewport?.height ?? window.innerHeight ?? root.clientHeight));

    root.style.setProperty('--sway-viewport-width', `${width}px`);
    root.style.setProperty('--sway-viewport-height', `${height}px`);
    root.classList.toggle('is-compact-viewport', width <= 640 && height <= 760);
    root.classList.toggle('is-compact-landscape', height <= 480 && width > height);
  };

  root.classList.toggle('is-meta-in-app-browser', isMetaInAppBrowser());
  updateViewport();

  window.addEventListener('resize', updateViewport, { passive: true });
  window.addEventListener('orientationchange', updateViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', updateViewport, { passive: true });
}
