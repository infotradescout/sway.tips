import { useEffect, useState, useSyncExternalStore } from 'react';
import { createCatalogReader } from './performer-catalog-reads';

export function usePerformerCatalog() {
  const [reader] = useState(() => createCatalogReader());
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    reader.start();
    return reader.stop;
  }, [reader]);
  return { ...snapshot, reader };
}
