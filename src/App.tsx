/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Smartphone, 
  Tv, 
  Info, 
  RotateCcw, 
  Flame, 
  ArrowRight,
  TrendingUp,
  Music,
  Check
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { BackendState, GigSession, RequestItem } from './types';
import TalentDashboard from './components/TalentDashboard';
import PatronView from './components/PatronView';
import VictoryScreen from './components/VictoryScreen';
import WalletPassModal from './components/WalletPassModal';

export default function App() {
  // Test/User Mode: 'talent' (Performer console) or 'patron' (Audience checkout)
  const [userMode, setUserMode] = useState<'talent' | 'patron'>('patron');
  
  // App state holds (synced from Express Server backend in real-time)
  const [bState, setBState] = useState<BackendState>({
    session: {
      status: 'active',
      talentName: 'DJ Shadow',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      endGigTimerStartedAt: null,
      totals: { totalTips: 85, accumulatedFees: 12, totalCount: 4, topRequest: 'Mr. Brightside' }
    },
    requests: []
  });

  const [isLoading, setIsLoading] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [isOverlay, setIsOverlay] = useState(false);

  // Sync state helper from server
  const fetchState = async () => {
    try {
      const response = await fetch('/api/state');
      const data = await response.json();
      setBState(data);
    } catch (e) {
      console.warn("Unable to sync server state:", e);
    } finally {
      setIsLoading(false);
    }
  };

  // Check URL attributes on mounting
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('overlay') === 'true') {
      setIsOverlay(true);
    }
    
    fetchState();

    // 4-Second Real-Time Synchronization Polling Loop!
    const interval = setInterval(fetchState, 4000);

    // Fast force refresh on demand
    const handleForceSync = () => fetchState();
    window.addEventListener('re-fetch-state', handleForceSync);

    return () => {
      clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, []);

  // API Callbacks for State modification
  const handleStartSession = async (setupData: {
    talentName: string;
    talentRole: 'DJ' | 'Bartender' | 'Performer';
    feeType: 'talent' | 'patron';
    minimumTip: number;
  }) => {
    try {
      const response = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setupData)
      });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleEndSession = async () => {
    try {
      const response = await fetch('/api/session/end', { method: 'POST' });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseout = async () => {
    try {
      const response = await fetch('/api/session/closeout', { method: 'POST' });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateRequest = async (requestData: any) => {
    try {
      const response = await fetch('/api/request/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      });
      const data = await response.json();
      setBState(data.state);
      return data;
    } catch (e) {
      console.error(e);
    }
  };

  const handleBoostRequest = async (requestId: string, patronName: string, amount: number) => {
    try {
      const response = await fetch('/api/request/boost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, patronName, boostAmount: amount })
      });
      const data = await response.json();
      setBState(data.state);
      return data;
    } catch (e) {
      console.error(e);
    }
  };

  const handleTriageRequest = async (requestId: string, action: 'approve' | 'deny') => {
    try {
      const response = await fetch('/api/request/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action })
      });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFulfillRequest = async (requestId: string) => {
    try {
      const response = await fetch('/api/request/fulfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId })
      });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const resetInactiveSession = () => {
    handleStartSession({
      talentName: 'DJ Shadow',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5
    });
  };

  const { session, requests } = bState;

  // Streamer Overlay Mode Render Page (Transparent Widget Feed)
  if (isOverlay) {
    const liveLadder = requests
      .filter(r => r.status === 'approved')
      .sort((a, b) => b.amount - a.amount);

    return (
      <div className="absolute inset-0 bg-transparent text-white p-4 overflow-hidden select-none">
        <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2 mb-3">
          <span className="font-display text-xs font-black tracking-widest text-fuchsia-400">
            SWAY ACTION CARDS
          </span>
          <span className="text-[9px] font-mono text-cyan-400 mr-1 animate-pulse">📶 LIVE GIG FEED</span>
        </div>

        <div className="space-y-2.5">
          {liveLadder.slice(0, 5).map((req, idx) => (
            <div 
              key={req.id} 
              className={`flex items-center justify-between p-2 rounded-lg border text-xs transition-transform ${
                idx === 0 
                  ? 'bg-slate-950/90 border-fuchsia-500/50 glow-fuchsia text-white' 
                  : 'bg-slate-900/80 border-white/5'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`font-mono font-bold text-[10px] px-1 py-0.5 rounded ${idx === 0 ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-slate-800 text-slate-400'}`}>
                  #{idx + 1}
                </span>
                <span className="font-bold truncate">{req.title}</span>
              </div>
              <span className="font-mono text-cyan-400 font-bold ml-2">${req.amount}</span>
            </div>
          ))}
          {liveLadder.length === 0 && (
            <div className="text-center py-4 bg-slate-950/40 rounded border border-white/5 text-[10px] text-slate-500 font-mono">
              Waiting for gig requests...
            </div>
          )}
        </div>
      </div>
    );
  }

  // Loading Screen
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-fuchsia-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-slate-400 font-mono">Synchronizing Sway live ledger...</p>
        </div>
      </div>
    );
  }

  // Victor Recaps Shift Complete Screen
  if (session.status === 'closed') {
    return (
      <VictoryScreen 
        session={session} 
        onRestart={resetInactiveSession} 
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      
      {/* 1. SANDBOX TESTING PROFILE SWITCHER TOOLBAR */}
      <div className="bg-slate-900 border-b border-white/10 py-3.5 px-4 select-none relative z-40">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-1 rounded bg-fuchsia-500/10 text-fuchsia-400">
              <Flame className="w-4.5 h-4.5 animate-pulse" />
            </div>
            <div>
              <span className="text-xs font-black font-display tracking-widest text-white uppercase">
                Sway Sandbox
              </span>
              <p className="text-[9px] text-slate-400">Simulate both sides of the Sway Request &amp; Tip Auction dynamically</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500 font-mono uppercase mr-2 hidden md:inline">TEST ENVIRONMENT PROFILE:</span>
            
            <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setUserMode('patron')}
                className={`py-1.5 px-3 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  userMode === 'patron' 
                    ? 'bg-fuchsia-600 text-white shadow' 
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" /> Patron scan view
              </button>
              
              <button
                onClick={() => setUserMode('talent')}
                className={`py-1.5 px-3 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  userMode === 'talent' 
                    ? 'bg-fuchsia-600 text-white shadow' 
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Users className="w-3.5 h-3.5" /> Talent booth screen
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Main Page Render Canvas */}
      <main className="flex-1">
        <AnimatePresence mode="wait">
          {userMode === 'talent' ? (
            <motion.div
              key="talent"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3 }}
            >
              <TalentDashboard 
                session={session}
                requests={requests}
                onStartSession={handleStartSession}
                onEndSession={handleEndSession}
                onCloseout={handleCloseout}
                onTriage={handleTriageRequest}
                onFulfill={handleFulfillRequest}
                onOpenTools={() => setShowTools(true)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="patron"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3 }}
            >
              <PatronView 
                session={session}
                requests={requests}
                performers={bState.performers || []}
                onCreateRequest={handleCreateRequest}
                onBoostRequest={handleBoostRequest}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Hardware & Promos Modal Overlay Drawer */}
      <WalletPassModal 
        isOpen={showTools} 
        onClose={() => setShowTools(false)} 
        session={session} 
      />

    </div>
  );
}
