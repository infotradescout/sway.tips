export type SwayNetworkStatus = {
  connected: boolean;
  source: 'capacitor-network' | 'browser-window';
  nativePlatform: boolean;
};

type CapacitorNetworkListener = {
  remove?: () => Promise<void> | void;
};

type CapacitorNetworkPlugin = {
  getStatus?: () => Promise<{ connected?: boolean }>;
  addListener?: (
    eventName: string,
    listener: (status: { connected?: boolean }) => void
  ) => Promise<CapacitorNetworkListener> | CapacitorNetworkListener;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: {
    Network?: CapacitorNetworkPlugin;
  };
};

function getCapacitorGlobal(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

function getBrowserConnected() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

export function getInitialNetworkStatus(): SwayNetworkStatus {
  const capacitor = getCapacitorGlobal();
  const nativePlatform = capacitor?.isNativePlatform?.() === true;

  return {
    connected: getBrowserConnected(),
    source: nativePlatform ? 'capacitor-network' : 'browser-window',
    nativePlatform
  };
}

export function subscribeToNetworkStatus(listener: (status: SwayNetworkStatus) => void) {
  if (typeof window === 'undefined') return () => {};

  const capacitor = getCapacitorGlobal();
  const nativePlatform = capacitor?.isNativePlatform?.() === true;
  const networkPlugin = capacitor?.Plugins?.Network;
  let disposed = false;
  let removeNativeListener: (() => void) | null = null;

  const emitBrowserStatus = () => {
    listener({
      connected: getBrowserConnected(),
      source: nativePlatform ? 'capacitor-network' : 'browser-window',
      nativePlatform
    });
  };

  const browserHandler = () => {
    emitBrowserStatus();
  };

  window.addEventListener('online', browserHandler);
  window.addEventListener('offline', browserHandler);

  if (nativePlatform && networkPlugin?.getStatus) {
    void networkPlugin.getStatus()
      .then((status) => {
        if (disposed) return;
        listener({
          connected: status.connected !== false,
          source: 'capacitor-network',
          nativePlatform: true
        });
      })
      .catch(() => {
        if (!disposed) emitBrowserStatus();
      });
  } else {
    emitBrowserStatus();
  }

  if (nativePlatform && networkPlugin?.addListener) {
    void Promise.resolve(
      networkPlugin.addListener('networkStatusChange', (status) => {
        if (disposed) return;
        listener({
          connected: status.connected !== false,
          source: 'capacitor-network',
          nativePlatform: true
        });
      })
    ).then((subscription) => {
      removeNativeListener = () => {
        void subscription?.remove?.();
      };
    }).catch(() => {});
  }

  return () => {
    disposed = true;
    window.removeEventListener('online', browserHandler);
    window.removeEventListener('offline', browserHandler);
    removeNativeListener?.();
  };
}
