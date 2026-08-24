import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import CollaboratorInbox from '../../src/components/CollaboratorInbox';
import PerformerAudioFiles from '../../src/components/PerformerAudioFiles';

const mode = new URLSearchParams(window.location.search).get('mode');

declare global {
  interface Window {
    __swayRefreshCollaboration?: () => void;
  }
}

function CollaboratorCandidateHarness() {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    window.__swayRefreshCollaboration = () => setRefreshKey((current) => current + 1);
    return () => {
      delete window.__swayRefreshCollaboration;
    };
  }, []);

  return <CollaboratorInbox refreshKey={refreshKey} />;
}

createRoot(document.getElementById('root')!).render(
  mode === 'creator' ? <PerformerAudioFiles /> : <CollaboratorCandidateHarness />
);
