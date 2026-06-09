/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Play, 
  Trash2, 
  Check, 
  X, 
  Coins, 
  Clock, 
  AlertTriangle, 
  TrendingUp, 
  Sparkles, 
  Award, 
  Users, 
  Settings, 
  Flame, 
  Radio, 
  Search,
  Badge,
  Plus,
  Sliders,
  ToggleLeft,
  ToggleRight,
  Hourglass
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GigSession, RequestItem, RequestPreset } from '../types';

interface TalentDashboardProps {
  session: GigSession;
  requests: RequestItem[];
  onStartSession: (data: { talentName: string; talentRole: 'DJ' | 'Bartender' | 'Performer'; feeType: 'talent' | 'patron'; minimumTip: number }) => void;
  onEndSession: () => void;
  onCloseout: () => void;
  onTriage: (requestId: string, action: 'approve' | 'deny') => void;
  onFulfill: (requestId: string) => void;
  onHide: (requestId: string) => void;
  onRemove: (requestId: string) => void;
  previewMode?: boolean;
}

export default function TalentDashboard({
  session,
  requests,
  onStartSession,
  onEndSession,
  onCloseout,
  onTriage,
  onFulfill,
  onHide,
  onRemove,
  previewMode = false
}: TalentDashboardProps) {
  // Session Configuration Setup States (for Starting New Session)
  const [setupName, setSetupName] = useState('');
  const [setupRole, setSetupRole] = useState<'DJ' | 'Bartender' | 'Performer'>('DJ');
  const [setupFeeType, setSetupFeeType] = useState<'talent' | 'patron'>('patron');
  const [setupMinTip, setSetupMinTip] = useState(5);
  
  // Local state for interactive settings drawer
  const [showSettings, setShowSettings] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>('05:00');

  // Featured Status Management States
  const [selectedHours, setSelectedHours] = useState<number>(3);
  const [featureTimeLeft, setFeatureTimeLeft] = useState<string>('');

  useEffect(() => {
    if (!session.isFeatured || !session.featuredExpiresAt) {
      setFeatureTimeLeft('');
      return;
    }

    const updateTimer = () => {
      const expireMs = new Date(session.featuredExpiresAt!).getTime();
      const diff = expireMs - Date.now();

      if (diff <= 0) {
        setFeatureTimeLeft('Expired');
      } else {
        const hours = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const secs = Math.floor((diff % 60000) / 1000);

        const hString = hours > 0 ? `${hours}h ` : '';
        const mString = mins < 10 ? `0${mins}` : mins;
        const sString = secs < 10 ? `0${secs}` : secs;

        setFeatureTimeLeft(`${hString}${mString}m ${sString}s`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [session.isFeatured, session.featuredExpiresAt]);

  const handleToggleFeature = async (hours: number, cost: number, activate: boolean) => {
    try {
      await fetch('/api/session/feature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours, cost, activate })
      });
      window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
    }
  };

  // Live request window and buildable custom presets states
  const [presetFormLabel, setPresetFormLabel] = useState('');
  const [presetFormDuration, setPresetFormDuration] = useState<number>(20); 
  const [windowTimeLeft, setWindowTimeLeft] = useState<string>('');

  useEffect(() => {
    if (!session.requestsOpen || session.requestWindowMode !== 'preset' || !session.requestWindowExpiresAt) {
      setWindowTimeLeft('');
      return;
    }

    const updateTimer = () => {
      const expireMs = new Date(session.requestWindowExpiresAt!).getTime();
      const diff = expireMs - Date.now();

      if (diff <= 0) {
        setWindowTimeLeft('Expired');
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const sString = secs < 10 ? `0${secs}` : secs;
        setWindowTimeLeft(`${mins}m ${sString}s`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [session.requestsOpen, session.requestWindowMode, session.requestWindowExpiresAt]);

  const handleToggleRequests = async (open: boolean) => {
    try {
      await fetch('/api/session/window/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ open })
      });
      window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
    }
  };

  const handleActivatePreset = async (durationMinutes: number, label: string) => {
    try {
      await fetch('/api/session/window/preset/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMinutes, label })
      });
      window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreatePreset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!presetFormLabel.trim() || presetFormDuration <= 0) return;
    try {
      const res = await fetch('/api/session/window/preset/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: presetFormLabel, durationMinutes: presetFormDuration })
      });
      if (res.ok) {
        setPresetFormLabel('');
        setPresetFormDuration(20);
        window.dispatchEvent(new CustomEvent('re-fetch-state'));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    try {
      await fetch('/api/session/window/preset/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId })
      });
      window.dispatchEvent(new CustomEvent('re-fetch-state'));
    } catch (e) {
      console.error(e);
    }
  };

  // Compute 5-minute countdown clock
  useEffect(() => {
    if (session.status !== 'ending' || !session.endGigTimerStartedAt) return;

    const interval = setInterval(() => {
      const startMs = new Date(session.endGigTimerStartedAt!).getTime();
      const difference = 300000 - (Date.now() - startMs);

      if (difference <= 0) {
        clearInterval(interval);
        onCloseout();
      } else {
        const mins = Math.floor(difference / 60000);
        const secs = Math.floor((difference % 60000) / 1000);
        const formattedSecs = secs < 10 ? `0${secs}` : secs;
        setTimeLeft(`0${mins}:${formattedSecs}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [session.status, session.endGigTimerStartedAt, onCloseout]);

  // Derived filter collections
  const triageQueue = requests.filter(r => r.status === 'hold' && !r.shadowBanned && !r.hidden && !r.removed);
  const liveLadderQueue = requests
    .filter(r => r.status === 'approved' && !r.hidden && !r.removed)
    .sort((a, b) => b.amount - a.amount); // SORTED BY LOWER TO HIGHEST OR HIGH TO LOW (AUCTION VALUE)
  const fulfilledHistory = requests.filter(r => (r.status === 'fulfilled' || r.type === 'tip') && !r.hidden && !r.removed);

  // Formatter for currency
  const formatValue = (val: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  };

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    onStartSession({
      talentName: setupName,
      talentRole: setupRole,
      feeType: setupFeeType,
      minimumTip: setupMinTip
    });
  };

  return (
    <div id="talent_dashboard_panel" className="max-w-6xl mx-auto py-6 px-4 space-y-8">
      
      {/* 1. Header & Live Stand Indicators */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 border border-white/10 p-6 rounded-2xl glass-panel glow-fuchsia">
        <div className="flex items-center gap-4">
          <div className="relative">
            <span className="absolute -top-1.5 -right-1.5 flex h-3 w-3 font-sans">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${session.status === 'active' ? 'bg-cyan-400' : 'bg-fuchsia-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${session.status === 'active' ? 'bg-cyan-500' : 'bg-fuchsia-500'}`}></span>
            </span>
            <div className="w-12 h-12 rounded-xl bg-slate-950 border border-white/10 flex items-center justify-center text-fuchsia-400">
              <Radio className={`w-6 h-6 ${session.status === 'active' && 'animate-pulse'}`} />
            </div>
          </div>
          <div className="font-sans">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-lg font-bold text-white tracking-wide uppercase">
                {session.status === 'inactive' ? 'Configure Shift Setup' : session.talentName}
              </h2>
              {session.status !== 'inactive' && (
                <span className="text-[10px] font-mono font-black uppercase tracking-wider bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-400 px-2 py-0.5 rounded-full select-none">
                  {session.talentRole} MODULE
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-sans mt-0.5">
              {session.status === 'active' && '🎙️ Live taking crowd tips'}
              {session.status === 'ending' && '⏳ Post-Gig 5-Minute Sweep timer ticking'}
              {session.status === 'inactive' && 'Select your performance rules to generate QR Code'}
            </p>
            {previewMode && (
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-amber-200">
                Preview data only; no live tips are being collected.
              </p>
            )}
          </div>
        </div>

        {/* Header CTA Tools */}
          {session.status !== 'inactive' && (
            <div className="flex items-center gap-3 font-sans">
              {session.status === 'active' ? (
                <button
                onClick={previewMode ? undefined : onEndSession}
                disabled={previewMode}
                className="flex items-center gap-1.5 px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white border border-fuchsia-600 shadow rounded-xl text-xs font-bold transition-all cursor-pointer glow-fuchsia font-sans"
              >
                <X className="w-4 h-4" /> {previewMode ? 'Preview only' : 'End Gig Live'}
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-400 font-mono font-bold text-xs px-2.5 py-1 rounded select-none">
                  <Clock className="w-3.5 h-3.5 animate-spin" /> Sweep: {timeLeft}
                </div>
                <button 
                  onClick={previewMode ? undefined : onCloseout}
                  disabled={previewMode}
                  className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-bold border border-fuchsia-600 rounded-xl text-xs transition-transform transform active:scale-95 cursor-pointer glow-fuchsia"
                >
                  {previewMode ? 'Preview only' : 'Close Out & Capture'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. Inactive Session Configuration Form */}
      {session.status === 'inactive' && (
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-slate-900 border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl max-w-2xl mx-auto space-y-6 glow-fuchsia"
        >
          <div className="text-center space-y-2">
            <h3 className="font-display text-2xl font-black text-white tracking-tight uppercase">Setup Your Live Desk</h3>
            <p className="text-sm text-slate-400 font-sans">Configure parameters before letting patrons check out on their smartphones.</p>
          </div>

          <form onSubmit={handleStart} className="space-y-6">
            
            {/* Performer Vitals */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-semibold font-mono tracking-wider uppercase">PERFOMER / DESK NAME</label>
                <input 
                  type="text" 
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                  placeholder="e.g. DJ Luna, Bartender Dave"
                  required
                  className="w-full bg-slate-950 px-4 py-3 rounded-xl border border-white/5 text-white text-sm focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none font-medium font-sans"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-semibold font-mono tracking-wider uppercase">MODALITY / PERFORMANCE TYPE</label>
                <select 
                  value={setupRole}
                  onChange={(e) => setSetupRole(e.target.value as any)}
                  className="w-full bg-slate-950 px-4 py-3 rounded-xl border border-white/5 text-slate-300 text-sm focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none font-medium cursor-pointer"
                >
                  <option value="DJ">🎵 DJ (Music search + Album Art)</option>
                  <option value="Bartender">🍸 Bartender (Cocktail menu triggers)</option>
                  <option value="Performer">🎤 Street Magician / Live Artist (Action list)</option>
                </select>
              </div>
            </div>

            {/* Platform Fee Responsibility */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-xs text-slate-400 font-semibold font-mono tracking-wider uppercase">EAT PLATFORM TRANSACTION FEE ($1.00)</label>
                <span className="text-[10px] font-mono text-cyan-400 uppercase font-black">PAYMENTS PENDING</span>
              </div>
              
              <div className="grid sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setSetupFeeType('patron')}
                  className={`p-4 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                    setupFeeType === 'patron'
                      ? 'border-fuchsia-500 bg-fuchsia-500/5 text-fuchsia-400 glow-fuchsia'
                      : 'border-white/5 bg-slate-950/40 text-slate-400 hover:border-white/20'
                  }`}
                >
                  <span className="text-xs font-bold text-white mb-1">Pass as Convenience Fee</span>
                  <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                    Audience pays $1.00 platform processing fee during checkout. Performer collects 100% of tip.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSetupFeeType('talent')}
                  className={`p-4 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                    setupFeeType === 'talent'
                      ? 'border-fuchsia-500 bg-fuchsia-500/5 text-fuchsia-400 glow-fuchsia'
                      : 'border-white/5 bg-slate-950/40 text-slate-400 hover:border-white/20'
                  }`}
                >
                  <span className="text-xs font-bold text-white mb-1">Absorb Processing Cost</span>
                  <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                    Performer absorbs the flat $1.00 cut to keep audience checkout fees clean. Boost volume.
                  </p>
                </button>
              </div>
            </div>

            {/* Minimum Entrance Bar Check */}
            <div className="bg-slate-950 p-4 rounded-xl border border-white/5 space-y-3">
              <div className="flex justify-between items-center text-sm font-mono text-slate-400">
                <span>Minimum Tip Entrance Entry</span>
                <span className="text-fuchsia-400 font-bold">${setupMinTip}.00</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="25" 
                step="1"
                value={setupMinTip}
                onChange={(e) => setSetupMinTip(Number(e.target.value))}
                className="w-full accent-fuchsia-500 cursor-pointer"
              />
              <p className="text-[11px] text-slate-500 font-sans font-medium">
                Every request requires this baseline to prevent micro-transaction spam and system clutter.
              </p>
            </div>

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 py-3 auction-gradient text-white font-bold rounded-xl text-sm transition-all shadow-lg glow-fuchsia transform active:scale-95 cursor-pointer"
            >
              <Play className="w-4 h-4" /> Initialize Live Gig Space
            </button>
          </form>
        </motion.div>
      )}

      {/* 3. Live Core Session Workflows */}
      {session.status !== 'inactive' && (
        <div className="grid lg:grid-cols-3 gap-8">
          
          {/* Main Triage and Live Auction Columns */}
          <div className="lg:col-span-2 space-y-8">

            {/* 3-KILL. ALWAYS-VISIBLE OPERATOR KILL SWITCH */}
            <div
              className={`rounded-2xl p-4 border flex items-center justify-between gap-4 shadow-lg select-none ${
                session.requestsOpen
                  ? 'bg-emerald-950/30 border-emerald-500/30'
                  : 'bg-rose-950/40 border-rose-500/40'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`w-3 h-3 rounded-full shrink-0 ${session.requestsOpen ? 'bg-emerald-400 shadow-md shadow-emerald-500/50 animate-pulse' : 'bg-rose-400'}`} />
                <div className="min-w-0">
                  <p className={`text-sm font-black uppercase tracking-wide font-display ${session.requestsOpen ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {session.requestsOpen ? 'Requests Live' : 'All Requests Paused'}
                  </p>
                  <p className="text-[11px] text-slate-400 font-sans leading-snug">
                    {session.requestsOpen
                      ? 'Patrons can submit. Tap pause to immediately halt all inbound requests.'
                      : 'New patron submissions are halted. Tap resume to reopen the queue.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleToggleRequests(!session.requestsOpen)}
                className={`shrink-0 px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wide flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer ${
                  session.requestsOpen
                    ? 'bg-rose-500 text-slate-950 hover:bg-rose-400 shadow-lg shadow-rose-500/20'
                    : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20'
                }`}
              >
                {session.requestsOpen ? (
                  <><ToggleLeft className="w-4 h-4 shrink-0" /> Pause All Requests</>
                ) : (
                  <><ToggleRight className="w-4 h-4 shrink-0" /> Resume Requests</>
                )}
              </button>
            </div>
            
            {/* 3a. POST-GIG FINAL SWEEP INDICATOR */}
            {session.status === 'ending' && (
              <div className="bg-amber-950/40 p-5 rounded-2xl border border-amber-900/30 flex items-start gap-4">
                <AlertTriangle className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1 select-none">
                  <h4 className="text-sm font-bold text-amber-200">5-Minute Final Check is ticking</h4>
                  <p className="text-xs text-amber-300 leading-relaxed">
                    Review your pending queue below. Tap approval on anything you actually fulfilled but forgot to log. Real payment void/refund handling will be added in the payments sprint.
                  </p>
                </div>
              </div>
            )}

            {/* 3b. PRIVATE TRIAGE QUEUE (AUTHORIZE ESCROW) */}
            <div className="space-y-4">
              <div className="flex justify-between items-center select-none font-sans">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-base font-bold text-white tracking-wide uppercase">
                    Private Triage Desk
                  </h3>
                  <span className="text-xs bg-slate-900 border border-white/5 text-slate-400 font-mono px-2 py-0.5 rounded-full select-none">
                    {triageQueue.length} Pending
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest flex items-center gap-1">
                  REVIEW BEFORE PUBLIC LADDER
                </span>
              </div>

              <div id="triage_requests_list" className="space-y-3 font-sans">
                <AnimatePresence mode="popLayout">
                  {triageQueue.length === 0 ? (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-center p-8 bg-slate-900/10 border border-dashed border-white/5 rounded-2xl space-y-2 select-none"
                    >
                      <Check className="w-6 h-6 text-slate-600 mx-auto" />
                      <div className="text-xs font-semibold text-slate-400">Queue cleared!</div>
                      <p className="text-[10px] text-slate-500">Pending crowd requests appear here for review first.</p>
                    </motion.div>
                  ) : (
                    triageQueue.map((req) => (
                      <motion.div
                        key={req.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        className="p-4 bg-slate-900/60 border border-white/5 rounded-xl flex items-center justify-between gap-4 hover:border-white/10 transition-colors"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          {req.albumArt && (
                            <img 
                              src={req.albumArt} 
                              alt="track" 
                              referrerPolicy="no-referrer"
                              className="w-12 h-12 rounded-lg bg-slate-850 shrink-0 object-cover border border-white/15 shadow-sm" 
                            />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-1.5 font-sans text-sm font-bold text-white truncate">
                              <span>{req.title}</span>
                              <span className="font-mono text-xs text-fuchsia-400 font-black mt-1">{formatValue(req.amount)}</span>
                            </div>
                            <p className="text-xs text-slate-400 truncate mt-0.5 font-medium">{req.subtitle}</p>
                            
                            <div className="flex items-center gap-2 mt-2 text-[10px]">
                              <span className="font-mono font-bold text-cyan-400 bg-cyan-950/40 border border-cyan-500/10 px-1.5 py-0.5 rounded">
                                {req.senderName}
                              </span>
                              {req.message && (
                                <span className="text-slate-400 truncate italic">"{req.message}"</span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Triage Accept (Move to Ladder) or Reject (Instant Void Hold) */}
                        <div className="flex items-center gap-2 font-sans">
                          <button
                            onClick={() => onHide(req.id)}
                            className="p-2.5 rounded-lg bg-slate-950 border border-white/5 text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/30 transition-all flex items-center gap-1 text-xs font-mono font-bold cursor-pointer"
                            title="Hide from performer/admin view"
                          >
                            <AlertTriangle className="w-4 h-4" /> Hide
                          </button>

                          <button
                            onClick={() => onTriage(req.id, 'deny')}
                            className="p-2.5 rounded-lg bg-slate-950 border border-white/5 text-slate-400 hover:text-fuchsia-400 hover:bg-fuchsia-500/10 hover:border-fuchsia-500/30 transition-all flex items-center gap-1 text-xs font-mono font-bold cursor-pointer"
                            title="Reject &amp; Void Hold"
                          >
                            <Trash2 className="w-4 h-4" /> Veto
                          </button>
                          
                          <button
                            onClick={() => onTriage(req.id, 'approve')}
                            className="bg-cyan-600 hover:bg-cyan-500 text-slate-955 text-slate-950 p-2.5 px-3.5 rounded-lg font-black text-xs transition-colors flex items-center gap-1.5 cursor-pointer shadow-lg shadow-cyan-500/10"
                            title="Approve request"
                          >
                            <Check className="w-4 h-4" /> Approve
                          </button>

                          <button
                            onClick={() => onRemove(req.id)}
                            className="p-2.5 rounded-lg bg-slate-950 border border-white/5 text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 hover:border-rose-500/30 transition-all flex items-center gap-1 text-xs font-mono font-bold cursor-pointer"
                            title="Remove from queue"
                          >
                            <Trash2 className="w-4 h-4" /> Remove
                          </button>
                        </div>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* 3c. THE LIVE REQUEST LADDER (APPROVED AUCTION STATE) */}
            <div className="space-y-4">
              <div className="flex justify-between items-center select-none font-sans">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-base font-bold text-white tracking-wide uppercase">
                    Live Audience Request Ladder
                  </h3>
                  <span className="text-[10px] bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-400 font-mono px-2.5 py-0.5 rounded-full select-none font-black tracking-wider uppercase animate-pulse">
                    AUCTION ACTIVE
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest flex items-center gap-1">
                  📶 PUBLIC VENUE LEADERBOARD
                </span>
              </div>

              <div id="ladder_active_queue" className="space-y-3 font-sans">
                <AnimatePresence mode="popLayout">
                  {liveLadderQueue.length === 0 ? (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-center p-8 bg-slate-900/10 border border-dashed border-white/5 rounded-2xl select-none"
                    >
                      <Sparkles className="w-6 h-6 text-slate-600 mx-auto" />
                      <div className="text-xs font-semibold text-slate-400">Ladder is currently vacant</div>
                      <p className="text-[10px] text-slate-500 font-medium font-sans mt-0.5">Approved submissions will appear here sorted by total bids!</p>
                    </motion.div>
                  ) : (
                    liveLadderQueue.map((req, index) => {
                      return (
                        <motion.div
                          key={req.id}
                          layoutId={req.id}
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ type: "spring", stiffness: 500, damping: 30 }}
                          className={`p-4 rounded-xl flex items-center justify-between gap-4 transition-all ${
                            index === 0 
                              ? 'bg-gradient-to-r from-fuchsia-950/20 via-slate-900/60 to-slate-900/60 border border-fuchsia-500/30 glow-fuchsia' 
                              : 'bg-slate-900/60 border border-white/5'
                          }`}
                        >
                          <div className="flex items-center gap-4 min-w-0">
                            {/* Standings index rank */}
                            <div className="flex flex-col items-center justify-center font-display font-black text-center pr-1 shrink-0">
                              <span className={`text-base ${index === 0 ? 'text-fuchsia-400 font-black italic' : 'text-slate-500 font-bold'}`}>
                                #{index + 1}
                              </span>
                              {index === 0 && (
                                <span className="text-[7px] bg-fuchsia-500 text-white font-sans uppercase font-black tracking-widest block px-1 py-0.5 rounded scale-90 mt-0.5 select-none animate-pulse">
                                  GOLD
                                </span>
                              )}
                            </div>

                            {req.albumArt && (
                              <img 
                                src={req.albumArt} 
                                alt="track" 
                                referrerPolicy="no-referrer"
                                className="w-12 h-12 rounded-lg bg-slate-850 shrink-0 object-cover border border-white/10 shadow-sm" 
                              />
                            )}
                            
                            <div className="min-w-0 font-sans">
                              <div className="flex items-baseline gap-1.5 font-sans text-sm font-bold text-white truncate font-sans">
                                <span>{req.title}</span>
                                <span className="font-mono text-cyan-400 text-xs font-bold">{formatValue(req.amount)}</span>
                              </div>
                              <p className="text-xs text-slate-400 truncate mt-0.5 leading-none font-medium font-sans">{req.subtitle}</p>

                              {/* Sponsor & co-giver tags */}
                              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                <span className="text-[8px] bg-slate-950 text-slate-400 px-1.5 py-0.5 border border-white/5 rounded font-mono">
                                  Pool Backers: {req.sponsorCount}
                                </span>
                                {req.boosts.slice(-2).map((b, bIdx) => (
                                  <span key={b.id} className="text-[8px] bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/10 px-1 py-0.5 rounded font-mono">
                                    +{formatValue(b.amount)} by {b.patronName}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>

                          {/* Fulfillment actions */}
                          <div>
                            <button
                              type="button"
                              onClick={previewMode ? undefined : () => onFulfill(req.id)}
                              disabled={previewMode}
                              className="bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-bold p-2.5 px-4 rounded-xl flex items-center gap-1.5 shadow transition-all transform active:scale-95 cursor-pointer glow-fuchsia"
                            >
                              <Award className="w-4 h-4" /> {previewMode ? 'Preview only' : 'Fulfill & Capture'}
                            </button>
                          </div>
                        </motion.div>
                      );
                    })
                  )}
                </AnimatePresence>
              </div>
            </div>

          </div>

          {/* Right sidebar panel: Stats and options summary */}
          <div className="space-y-6">
            
            {/* ⏱️ REQUEST TIME WINDOW COORDINATOR */}
            <div className={`border rounded-2xl p-5 space-y-4 shadow-lg relative overflow-hidden transition-all duration-300 ${
              session.requestsOpen 
                ? 'bg-slate-900 border-cyan-500/30' 
                : 'bg-slate-900 border-white/5'
            }`}>
              <div className="flex justify-between items-start select-none">
                <div>
                  <h4 className="font-display text-xs font-mono font-bold tracking-wider text-cyan-400 uppercase flex items-center gap-1.5 leading-none">
                    <Clock className="w-4 h-4 text-cyan-400" /> REQUEST TIME WINDOW
                  </h4>
                    <p className="text-[10px] text-slate-500 font-sans mt-0.5">Pause all requests instantly, then resume when ready.</p>
                </div>
                
                <div className="flex items-center gap-1.5 animate-pulse-subtle">
                  <span className={`w-2.5 h-2.5 rounded-full ${session.requestsOpen ? 'bg-emerald-500 shadow-md shadow-emerald-500/50' : 'bg-rose-500'}`} />
                  <span className={`text-[9px] font-black tracking-widest font-mono uppercase ${
                    session.requestsOpen ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {session.requestsOpen ? 'LIVE OPEN' : 'CLOSED'}
                  </span>
                </div>
              </div>

              {/* ACTIVE TIMER BANNER WITH COUNTDOWN */}
              {session.requestsOpen && session.requestWindowMode === 'preset' && windowTimeLeft && (
                <div className="p-3 bg-cyan-950/20 border border-cyan-500/30 rounded-xl text-center select-none shadow relative">
                  <span className="absolute top-1 right-1 bg-cyan-500 text-slate-950 text-[6px] font-black uppercase px-1 rounded font-mono animate-pulse">
                    TEMPORARY WINDOW
                  </span>
                  <p className="text-[9px] text-cyan-300 font-mono font-bold uppercase tracking-wider flex items-center justify-center gap-1">
                    <Hourglass className="w-3 h-3 text-cyan-400 animate-spin" style={{ animationDuration: '3s' }} /> SUBMISSIONS EXPIRE IN
                  </p>
                  <p className="text-xl font-black font-mono text-cyan-400 mt-0.5">{windowTimeLeft}</p>
                  <p className="text-[8px] text-slate-400 mt-1 leading-normal font-sans">
                    Preset: <strong className="text-slate-300">{session.requestWindowLabel}</strong> ({session.requestWindowDuration}m limit)
                  </p>
                </div>
              )}

              {/* OVERALL MANUAL TOGGLES */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleRequests(true)}
                  className={`py-2 px-3 text-2xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1 select-none ${
                    session.requestsOpen && session.requestWindowMode === 'manual'
                      ? 'bg-emerald-500 text-slate-950 font-black shadow-lg shadow-emerald-500/10'
                      : 'bg-slate-950 border border-white/5 text-emerald-400 hover:bg-emerald-950/15'
                  }`}
                >
                    <ToggleRight className="w-4 h-4 shrink-0" /> Resume Requests
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleRequests(false)}
                  className={`py-2 px-3 text-2xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1 select-none ${
                    !session.requestsOpen
                      ? 'bg-rose-500 text-slate-950 font-black shadow-lg shadow-rose-500/10'
                      : 'bg-slate-950 border border-white/5 text-rose-400 hover:bg-rose-950/15'
                  }`}
                >
                    <ToggleLeft className="w-4 h-4 shrink-0" /> Pause All Requests
                </button>
              </div>

              <div className="border-t border-white/5 my-2"></div>

              {/* PRESETS LIST & GRID */}
              <div className="space-y-2">
                <span className="text-[9px] font-mono font-bold uppercase text-slate-500 flex items-center gap-1 mt-1">
                  <Sliders className="w-3 h-3 text-indigo-400" /> Active Presets Trigger
                </span>

                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                  {(session.requestPresets && session.requestPresets.length > 0
                    ? session.requestPresets
                    : [
                        { id: "p-sys-15", label: "🔥 Speed Round", duration: 15, isSystem: true },
                        { id: "p-sys-30", label: "🌟 Mid-Gig Rush", duration: 30, isSystem: true },
                        { id: "p-sys-45", label: "🥁 Main Stage Vibe", duration: 45, isSystem: true }
                      ]
                  ).map((preset: RequestPreset) => {
                    const isCurrentActive = session.requestsOpen && 
                      session.requestWindowMode === 'preset' && 
                      session.requestWindowLabel === preset.label;
                    
                    return (
                      <div
                        key={preset.id}
                        onClick={() => handleActivatePreset(preset.duration, preset.label)}
                        className={`p-2.5 rounded-xl text-left transition-all border relative flex flex-col justify-between cursor-pointer group ${
                          isCurrentActive
                            ? 'bg-cyan-950/30 border-cyan-500/60 shadow shadow-cyan-400/10'
                            : 'bg-slate-950 border-white/5 hover:border-slate-800'
                        }`}
                      >
                        <div className="w-full">
                          <div className="flex justify-between items-start gap-1 w-full">
                            <span className={`text-[10px] font-bold truncate ${isCurrentActive ? 'text-cyan-300 font-extrabold' : 'text-slate-200'}`}>
                              {preset.label}
                            </span>
                            {!preset.isSystem && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeletePreset(preset.id);
                                }}
                                className="text-slate-500 hover:text-rose-400 p-0.5 transition-colors rounded hover:bg-white/5"
                                title="Delete preset"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          <span className={`text-[9px] font-mono mt-1 block font-semibold ${isCurrentActive ? 'text-cyan-400 font-bold' : 'text-slate-400'}`}>
                            ⏱️ {preset.duration} mins
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* BUILD A PRESET FORM */}
              <div className="bg-slate-950/60 p-3 rounded-xl border border-white/5 space-y-2">
                <span className="text-[9px] font-mono font-bold uppercase text-slate-500 block">
                  🛠️ Build Custom Time Preset
                </span>

                <form onSubmit={handleCreatePreset} className="space-y-2 font-sans">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      placeholder="e.g. Heavy Rush"
                      value={presetFormLabel}
                      onChange={(e) => setPresetFormLabel(e.target.value)}
                      className="flex-1 min-w-0 bg-slate-950 border border-white/15 focus:border-cyan-500/50 rounded-lg text-xs px-2.5 py-1.5 text-white outline-none font-semibold"
                    />
                    
                    <div className="flex items-center gap-1 bg-slate-950 border border-white/15 rounded-lg px-2 text-white">
                      <input
                        type="number"
                        min="1"
                        max="240"
                        required
                        value={presetFormDuration}
                        onChange={(e) => setPresetFormDuration(Math.max(1, Number(e.target.value) || 1))}
                        className="w-10 bg-transparent text-center border-none text-xs outline-none font-bold text-cyan-400"
                        title="Duration in minutes"
                      />
                      <span className="text-[9px] font-mono text-slate-500">m</span>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-1.5 flex items-center justify-center gap-1 bg-slate-900 border border-dashed border-cyan-500/30 hover:border-cyan-500/75 text-cyan-300 hover:text-cyan-200 rounded-lg text-[10px] font-black transition-all cursor-pointer font-sans"
                  >
                    <Plus className="w-3.5 h-3.5" /> BUILD TIME PRESET
                  </button>
                </form>
              </div>
            </div>

            {/* 🌟 FEATURED PERFORMER PREMIUM HUB */}
            <div className="bg-slate-900 border border-amber-500/20 rounded-2xl p-5 space-y-4 shadow-lg relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl -mr-6 -mt-6"></div>
              
              <div className="flex justify-between items-start select-none">
                <h4 className="font-display text-xs font-mono font-bold tracking-wider text-amber-400 uppercase flex items-center gap-1.5 leading-none">
                  <Award className="w-4 h-4 text-amber-400" /> FEATURED STATUS HUB
                </h4>
                {session.isFeatured ? (
                  <span className="text-[8px] font-black tracking-widest bg-amber-500 text-slate-950 px-2 py-0.5 rounded-full animate-bounce font-mono">
                    ACTIVE 🌟
                  </span>
                ) : (
                  <span className="text-[8px] font-black tracking-widest bg-slate-950 text-slate-400 px-2 py-0.5 rounded-full font-mono">
                    STANDARD
                  </span>
                )}
              </div>

              {session.isFeatured ? (
                // ACTIVE STATE
                <div className="space-y-3 font-sans">
                  <div className="p-3 bg-amber-950/15 border border-amber-500/35 rounded-xl text-center select-none shadow shadow-amber-500/5">
                    <p className="text-[10px] text-amber-300 font-mono font-bold uppercase tracking-wider">🌟 PROMOTION TIMER 🌟</p>
                    <p className="text-lg font-black font-mono text-amber-400 mt-1">{featureTimeLeft || 'Computing...'}</p>
                    <p className="text-[9px] text-slate-400 mt-1 leading-normal font-sans">Your listing is locked at the absolute top of discover directories!</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-center text-[10px] bg-slate-950 p-2.5 rounded-xl border border-white/5 font-mono select-none">
                    <div>
                      <span className="text-slate-500 block">COST REF</span>
                      <span className="text-amber-300 font-bold">${session.featuredCost}.00</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">DURATION</span>
                      <span className="text-amber-300 font-bold">{session.featuredDurationHours} hours</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={previewMode ? undefined : () => handleToggleFeature(0, 0, false)}
                    disabled={previewMode}
                    className="w-full text-center py-2 bg-slate-950 border border-white/5 text-xs font-bold text-slate-400 hover:text-red-400 hover:bg-red-950/10 hover:border-red-500/35 rounded-xl transition-all cursor-pointer"
                  >
                    {previewMode ? 'Preview only: promotion locked' : 'Veto / Cancel Promotion'}
                  </button>
                </div>
              ) : (
                // CONFIGURATION / EARN STATE
                <div className="space-y-4 font-sans">
                  <p className="text-xs text-slate-400 leading-relaxed font-sans">
                    Stand out immediately. Featured statuses prioritize your listing at the top of discover & venue search results, giving you maximum tip-earnings velocity.
                  </p>

                  {/* Hours Selector */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-semibold font-sans">
                      <span className="text-slate-400">Selected Duration</span>
                      <span className="text-amber-400 font-mono font-bold">{selectedHours} {selectedHours === 1 ? 'Hour' : 'Hours'}</span>
                    </div>

                    <div className="flex bg-slate-950 p-1 rounded-lg border border-white/5 gap-1 select-none">
                      {[1, 3, 6, 12, 24].map((hours) => (
                        <button
                          key={hours}
                          type="button"
                          onClick={() => setSelectedHours(hours)}
                          className={`flex-1 py-1 text-[10px] font-mono font-bold rounded transition-all cursor-pointer ${
                            selectedHours === hours 
                              ? 'bg-amber-500 text-slate-950 font-black shadow' 
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {hours}h
                        </button>
                      ))}
                    </div>

                    <div className="flex justify-between items-center text-xs p-2 bg-slate-950 rounded-xl border border-white/5 font-mono select-none">
                      <span className="text-slate-550 text-slate-500">Total Standard Rate:</span>
                      <span className="text-amber-400 font-extrabold">${selectedHours * 5}.00</span>
                    </div>
                  </div>

                  {/* Achievement Tracker to 'Earn' Status */}
                  <div className="bg-slate-950 p-3 rounded-xl border border-white/5 space-y-2">
                    <div className="flex justify-between items-center text-[9px] font-mono font-bold uppercase select-none">
                      <span className="text-slate-400">🏆 Earn Shift Achievement</span>
                      <span className="text-cyan-400">
                        {session.totals.totalTips >= 50 ? 'UNLOCKS FREE PROMO!' : `${Math.floor((session.totals.totalTips / 50) * 100)}%`}
                      </span>
                    </div>
                    
                    <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                      <div 
                        className="bg-cyan-500 h-full transition-all duration-300" 
                        style={{ width: `${Math.min(100, (session.totals.totalTips / 50) * 100)}%` }}
                      ></div>
                    </div>
                    
                    <p className="text-[9px] text-slate-500 leading-normal font-sans">
                      {session.totals.totalTips >= 50 
                        ? '🎉 Goal reached! Unlock your shift earnings to claim 2 hours of FREE Featured placement!' 
                        : 'Collect $50.00 total completed tips in your shifts to auto-unlock a 2-hour Featured spot for FREE.'}
                    </p>
                  </div>

                  {/* Actions Trigger */}
                  {session.totals.totalTips >= 50 ? (
                    <button
                      type="button"
                      onClick={previewMode ? undefined : () => handleToggleFeature(2, 0, true)}
                      disabled={previewMode}
                      className="w-full py-2.5 flex items-center justify-center gap-1 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-black rounded-xl text-xs font-semibold shadow-lg shadow-cyan-500/10 cursor-pointer text-center font-sans"
                    >
                      {previewMode ? 'Preview only: no promo action' : '🌟 Redeem Shift Achievement! (2-Hr Promo)'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={previewMode ? undefined : () => handleToggleFeature(selectedHours, selectedHours * 5, true)}
                      disabled={previewMode}
                      className="w-full py-2.5 flex items-center justify-center gap-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-xs font-semibold shadow-lg shadow-amber-500/10 cursor-pointer text-center font-sans"
                    >
                      {previewMode ? 'Preview only: no placement purchase' : `🌟 Unlock Placement ($${selectedHours * 5}.00)`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Realtime session performance card stats */}
            <div className="bg-slate-900 border border-white/10 rounded-2xl p-5 space-y-4 shadow-lg">
              <h4 className="font-display text-xs font-mono font-bold tracking-wider text-fuchsia-400 uppercase select-none">
                Performance Meter
              </h4>

              <div className="space-y-3 select-none font-sans">
                <div className="flex justify-between items-center text-xs text-slate-400">
                  <span>{previewMode ? 'Preview total shown:' : 'Current captured total:'}</span>
                  <span className="font-mono text-sm font-bold text-white">{formatValue(session.totals.totalTips)}</span>
                </div>
                
                <div className="flex justify-between items-center text-xs text-slate-400 font-sans">
                  <span>Pool backers:</span>
                  <span className="font-mono text-sm font-bold text-white">6 Givers</span>
                </div>

                <div className="flex justify-between items-center text-xs text-slate-400">
                  <span>Accumulated fees:</span>
                  <span className="font-mono text-xs text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded font-bold">
                    ${session.totals.accumulatedFees}.00 Fee
                  </span>
                </div>
              </div>

              <div className="pt-3 border-t border-white/5 space-y-2">
                <div className="text-[10px] text-slate-550 text-slate-500 font-mono tracking-wide uppercase">Top Requested Target:</div>
                <div className="text-sm font-bold text-white line-clamp-1">{session.totals.topRequest}</div>
              </div>
            </div>

          </div>

        </div>
      )}

    </div>
  );
}
