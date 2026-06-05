/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { 
  Smartphone, 
  Copy, 
  Check, 
  Tv, 
  Printer, 
  Gift, 
  Radio, 
  Sparkles, 
  QrCode, 
  X, 
  Download, 
  Flame, 
  CreditCard 
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GigSession } from '../types';

interface WalletPassModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: GigSession;
}

export default function WalletPassModal({ isOpen, onClose, session }: WalletPassModalProps) {
  const [activeTab, setActiveTab] = useState<'wallet' | 'overlay' | 'flyer' | 'nfc'>('wallet');
  const [copiedText, setCopiedText] = useState<'overlay' | 'flyer' | null>(null);
  const [flyerTheme, setFlyerTheme] = useState<'neon' | 'sunset' | 'clean'>('neon');
  const [customVapor, setCustomVapor] = useState(false);
  const [showNfcTapEffect, setShowNfcTapEffect] = useState(false);

  if (!isOpen) return null;

  const mockAppUrl = window.location.origin;
  const overlayUrl = `${mockAppUrl}/overlay/local`;

  const handleCopy = (text: string, key: 'overlay' | 'flyer') => {
    navigator.clipboard.writeText(text);
    setCopiedText(key);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const currentEarnings = session.totals.totalTips;
  const targetEarnings = 50;
  const kitProgressPercent = Math.min(100, Math.round((currentEarnings / targetEarnings) * 100));

  return (
    <div id="digital_tools_modal" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm sm:p-6 overflow-y-auto">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ type: "spring", damping: 25, stiffness: 350 }}
        className="w-full max-w-4xl bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden glass-panel"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800 bg-gray-950/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400">
              <Gift className="w-5 h-5" id="digital_tools_header_icon" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-white tracking-wide" id="digital_tools_title">
                Hardware &amp; Display Growth Suite
              </h2>
              <p className="text-xs text-gray-400">Distribute your tip link digitally and physical tap-to-pay kits</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-gray-800 bg-gray-950/20 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('wallet')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'wallet' 
                ? 'border-rose-500 text-rose-400 bg-rose-500/5' 
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/20'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            Double-Click Wallet Pass
          </button>
          
          <button
            onClick={() => setActiveTab('overlay')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'overlay' 
                ? 'border-rose-500 text-rose-400 bg-rose-500/5' 
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/20'
            }`}
          >
            <Tv className="w-4 h-4" />
            OBS/Stream Overlay
          </button>

          <button
            onClick={() => setActiveTab('flyer')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'flyer' 
                ? 'border-rose-500 text-rose-400 bg-rose-500/5' 
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/20'
            }`}
          >
            <Printer className="w-4 h-4" />
            Flyer Templates
          </button>

          <button
            onClick={() => setActiveTab('nfc')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'nfc' 
                ? 'border-rose-500 text-rose-400 bg-rose-500/5' 
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/20'
            }`}
          >
            <Radio className="w-4 h-4" />
            Physical Stand &amp; NFC
          </button>
        </div>

        {/* Modal content */}
        <div className="p-6 md:p-8 overflow-y-auto max-h-[65vh]">
          <AnimatePresence mode="wait">
            
            {/* Wallet Pass Tab */}
            {activeTab === 'wallet' && (
              <motion.div
                key="wallet"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="grid md:grid-cols-2 gap-8 items-center"
              >
                {/* Simulated Wallet Pass */}
                <div className="flex justify-center">
                  <div className="relative w-72 h-[380px] bg-gradient-to-br from-indigo-950 to-gray-950 border border-indigo-500/35 rounded-2xl shadow-xl overflow-hidden shadow-indigo-950/40">
                    <div className="absolute inset-0 bg-grid-bg opacity-10"></div>
                    <div className="absolute top-0 inset-x-0 h-[6px] bg-indigo-500"></div>
                    
                    {/* Apple Wallet Header */}
                    <div className="px-5 pt-5 pb-3 bg-gray-950/60 border-b border-indigo-950/50 flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded bg-rose-500/20 border border-rose-500/30 flex items-center justify-center">
                          <Flame className="w-3.5 h-3.5 text-rose-400" />
                        </div>
                        <span className="text-xs font-bold font-display uppercase tracking-wider text-rose-400">SWAY</span>
                      </div>
                      <span className="text-[10px] bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 font-mono px-1.5 py-0.5 rounded">
                        WALLET PASS
                      </span>
                    </div>

                    {/* Performer Card Info */}
                    <div className="p-5 flex flex-col justify-between h-[300px]">
                      <div>
                        <div className="text-[10px] text-gray-500 tracking-wider font-mono uppercase">PERFORMER</div>
                        <div className="text-lg font-bold font-display text-white mt-0.5 leading-none">{session.talentName}</div>
                        <div className="text-xs text-rose-400 mt-1 font-medium italic">{session.talentRole} Options</div>

                        <div className="grid grid-cols-2 gap-4 mt-6">
                          <div>
                            <div className="text-[9px] text-gray-500 tracking-wider font-mono uppercase">MINIMUM ENTRY</div>
                            <div className="text-sm font-bold text-indigo-300 font-mono mt-0.5">${session.minimumTip}.00</div>
                          </div>
                          <div>
                            <div className="text-[9px] text-gray-500 tracking-wider font-mono uppercase">PLATFORM FEE</div>
                            <div className="text-sm font-bold text-emerald-400 mt-0.5">
                              {session.feeType === 'patron' ? 'Patron Custom' : ' Talent Absorb'}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Display QR code */}
                      <div className={`flex flex-col items-center justify-end border rounded-xl p-4 mt-4 relative overflow-hidden ${
                        session.isFeatured
                          ? 'bg-amber-950/20 border-amber-500/50 glow-fuchsia'
                          : 'bg-white/5 border-white/5'
                      }`}>
                        {session.isFeatured && (
                          <div className="absolute top-0 right-0 bg-amber-500 text-slate-950 text-[6px] font-black uppercase px-2 py-0.5 rounded-bl font-mono">
                            🌟 FEATURED PERFORMER
                          </div>
                        )}
                        <QrCode className={`w-24 h-24 ${session.isFeatured ? 'text-amber-400 animate-pulse' : 'text-white'}`} />
                        <span className={`text-[10px] mt-2 font-mono uppercase tracking-widest flex items-center gap-1 ${session.isFeatured ? 'text-amber-300 font-bold' : 'text-gray-400'}`}>
                          <CreditCard className={`w-3 h-3 ${session.isFeatured ? 'text-amber-400' : 'text-rose-400'}`} /> TAP TO TIP / SCAN
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Left side detail prompt */}
                <div className="space-y-4">
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold">
                    <Sparkles className="w-3.5 h-3.5" /> Frictionless Booth Checkout
                  </div>
                  <h3 className="font-display text-xl font-bold text-white leading-snug">
                    Double-Click Phone Access
                  </h3>
                  <p className="text-sm text-gray-300 leading-relaxed">
                    Performers don't have time to load webs or print flyers. Sway generates a custom Apple Wallet &amp; Google Wallet Pass containing your QR code and contactless triggers. 
                  </p>
                  
                  <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2">
                    <div className="text-xs font-semibold text-white flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-rose-400" />
                      How to use at your gig:
                    </div>
                    <ol className="text-xs text-gray-400 list-decimal pl-4 space-y-1">
                      <li>Download the pass to your personal phone wallet</li>
                      <li>Double-click your power button behind the booth</li>
                      <li>Hold out your phone for rapid scans instantly</li>
                    </ol>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-bold transition-all hover:shadow-lg hover:shadow-indigo-600/20">
                      <Download className="w-4 h-4" /> Add to Apple Wallet
                    </button>
                    <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-820 hover:bg-gray-800 text-gray-100 border border-gray-700 hover:border-gray-600 rounded-xl text-sm font-bold transition-all">
                      <Download className="w-4 h-4" /> Add to Google Wallet
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* OBS Stream Overlay Tab */}
            {activeTab === 'overlay' && (
              <motion.div
                key="overlay"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-6"
              >
                <div className="grid md:grid-cols-2 gap-8 items-center">
                  <div className="space-y-4">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold">
                      <Radio className="w-3.5 h-3.5 animate-pulse" /> Live Stream Integrations
                    </div>
                    <h3 className="font-display text-xl font-bold text-white">
                      OBS &amp; Twitch Overlay URLs
                    </h3>
                    <p className="text-sm text-gray-300 leading-relaxed">
                      Streaming your gig online? Stream viewers can bid on songs and actions in real-time. Simply plug this transparent auto-updating Browser Source link directly into your OBS, vMix, or Twitch Studio overlays.
                    </p>

                    <div className="space-y-3">
                      <div className="text-xs font-mono text-gray-400 uppercase tracking-wider">Browser Source URL:</div>
                      <div className="flex gap-2">
                        <div className="flex-1 bg-gray-950 px-4 py-2.5 rounded-lg border border-gray-800 font-mono text-xs text-violet-400 truncate select-all flex items-center">
                          {overlayUrl}
                        </div>
                        <button 
                          onClick={() => handleCopy(overlayUrl, 'overlay')}
                          className="px-4 py-2 bg-gray-800 hover:bg-gray-750 text-white rounded-lg border border-gray-700 text-sm font-semibold flex items-center gap-1.5 transition-colors"
                        >
                          {copiedText === 'overlay' ? (
                            <>
                              <Check className="w-4 h-4 text-emerald-400" /> Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4" /> Copy URL
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="bg-violet-950/10 border border-violet-900/30 rounded-xl p-4 space-y-2">
                      <div className="text-xs font-bold text-violet-300 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-rose-400" /> Customizable Style Arguments:
                      </div>
                      <p className="text-xs text-gray-400 leading-relaxed">
                        Add <code className="text-violet-300 font-mono">&amp;theme=dark</code> or <code className="text-violet-300 font-mono">&amp;compact=true</code> to customize scaling, contrast levels, and opacity styles inside OBS seamlessly.
                      </p>
                    </div>
                  </div>

                  {/* Simulated Stream Widget */}
                  <div className="bg-gray-950 p-6 rounded-2xl border border-gray-800 h-80 flex flex-col justify-between relative overflow-hidden">
                    {/* Simulated stream video background overlay */}
                    <div className="absolute inset-0 bg-cover bg-center bg-gray-900 opacity-20 filter blur-[2px]" style={{ backgroundImage: "url('https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300')" }}></div>
                    <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-mono tracking-widest text-emerald-400 uppercase">
                      <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping mr-1"></span> Live On OBS
                    </div>

                    <div className="relative z-10">
                      <div className="text-xs font-mono uppercase tracking-wider text-rose-400 font-bold flex items-center gap-1">
                        <Tv className="w-3.5 h-3.5" /> LIVE BID LADDER (OBS WIDGET MOCKUP)
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1">Simulated transparent streamer feed browser overlay</p>
                    </div>

                    {/* Mini Ladder */}
                    <div className="relative z-10 space-y-2.5 my-4">
                      <div className="flex items-center justify-between bg-black/70 border border-rose-500/30 rounded-lg p-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] bg-rose-500/20 text-rose-300 px-1 py-0.5 rounded font-bold">#1</span>
                          <div>
                            <div className="font-bold text-white">Mr. Brightside</div>
                            <div className="text-[9px] text-gray-400">Emma &amp; Mike • $45.00</div>
                          </div>
                        </div>
                        <span className="text-xs font-mono text-emerald-400 font-bold">$45</span>
                      </div>

                      <div className="flex items-center justify-between bg-black/50 border border-white/5 rounded-lg p-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] bg-gray-800 text-gray-400 px-1 py-0.5 rounded font-bold">#2</span>
                          <div>
                            <div className="font-bold text-gray-300">Dancing Queen</div>
                            <div className="text-[9px] text-gray-400">Emma Solo • $15.00</div>
                          </div>
                        </div>
                        <span className="text-xs font-mono text-emerald-400 font-bold">$15</span>
                      </div>
                    </div>

                    <div className="relative z-10 text-[9px] text-center text-gray-500 font-mono">
                      Scanning qr code: sway.tips/{session.talentName.toLowerCase().replace(/\s+/g, '')}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Flyer Template Tab */}
            {activeTab === 'flyer' && (
              <motion.div
                key="flyer"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-6"
              >
                <div className="grid md:grid-cols-2 gap-8 items-center">
                  <div className="space-y-4">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-semibold">
                      <Printer className="w-3.5 h-3.5" /> Printable Table Tents
                    </div>
                    <h3 className="font-display text-xl font-bold text-white">
                      Print-At-Home Flyers
                    </h3>
                    <p className="text-sm text-gray-300 leading-relaxed">
                      Decorate your booth, stage, or bar area with highly visual flyers. Our design suite offers dynamic templates tailored to {session.talentRole}s, matching your vibe, rules, and colors perfectly.
                    </p>

                    <div className="space-y-2">
                      <div className="text-xs text-gray-400 font-semibold uppercase tracking-wider">Choose Theme Style:</div>
                      <div className="flex gap-2.5">
                        <button 
                          onClick={() => { setFlyerTheme('neon'); setCustomVapor(false); }}
                          className={`flex-1 py-2 px-3 text-xs font-mono font-medium rounded-lg border transition-all ${
                            flyerTheme === 'neon' 
                              ? 'bg-rose-500/10 border-rose-500 text-rose-400' 
                              : 'bg-gray-950 border-gray-800 text-gray-400 hover:text-white'
                          }`}
                        >
                          🎵 Neon Night
                        </button>
                        <button 
                          onClick={() => { setFlyerTheme('sunset'); setCustomVapor(true); }}
                          className={`flex-1 py-2 px-3 text-xs font-mono font-medium rounded-lg border transition-all ${
                            flyerTheme === 'sunset' 
                              ? 'bg-rose-500/10 border-rose-500 text-rose-400' 
                              : 'bg-gray-950 border-gray-800 text-gray-400 hover:text-white'
                          }`}
                        >
                          🌅 Sunset Jazz
                        </button>
                        <button 
                          onClick={() => { setFlyerTheme('clean'); setCustomVapor(false); }}
                          className={`flex-1 py-2 px-3 text-xs font-mono font-medium rounded-lg border transition-all ${
                            flyerTheme === 'clean' 
                              ? 'bg-rose-500/10 border-rose-500 text-rose-400' 
                              : 'bg-gray-950 border-gray-800 text-gray-400 hover:text-white'
                          }`}
                        >
                          ⬜ Minimalist Slate
                        </button>
                      </div>
                    </div>

                    <div className="flex gap-3 pt-4">
                      <button 
                        onClick={() => handleCopy(mockAppUrl, 'flyer')}
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-gray-800 hover:bg-gray-750 text-white rounded-xl text-xs font-bold border border-gray-700 transition-colors"
                      >
                        {copiedText === 'flyer' ? "Copied Link!" : "Copy Scan URL"}
                      </button>
                      
                      <button className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-all hover:shadow-lg hover:shadow-rose-600/20">
                        <Download className="w-4 h-4" /> Download PDF/Print
                      </button>
                    </div>
                  </div>

                  {/* Simulated Table Tent Flyer */}
                  <div className="flex justify-center">
                    <div id="flyer_flyout_preview" className={`w-64 h-92 border p-5 flex flex-col justify-between items-center text-center shadow-2xl rounded-lg transition-all duration-300 ${
                      flyerTheme === 'neon' 
                        ? 'bg-gray-950 border-rose-500/40 text-white' 
                        : flyerTheme === 'sunset'
                          ? 'bg-gradient-to-b from-amber-950 to-rose-950 border-amber-500/30 text-amber-100'
                          : 'bg-white border-gray-300 text-gray-950'
                    }`}>
                      <div>
                        {/* Header Badge */}
                        <div className={`text-[9px] uppercase tracking-widest font-mono py-0.5 px-2 rounded-full mb-3 inline-block ${
                          flyerTheme === 'clean' 
                            ? 'bg-gray-100 text-gray-600' 
                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        }`}>
                          {session.talentRole} REQUESTS LIVE
                        </div>
                        
                        <h4 className="font-display text-xl font-bold mt-1 tracking-tight">
                          {session.talentName}
                        </h4>
                        
                        <p className={`text-[10px] mt-2 max-w-[200px] mx-auto ${
                          flyerTheme === 'clean' ? 'text-gray-500' : 'text-gray-400'
                        }`}>
                          Cast a tip, place a request, or boost the ladder from the gig QR route.
                        </p>
                      </div>

                      {/* Display QR code */}
                      <div className={`p-3 rounded-xl flex flex-col items-center justify-center my-3 relative overflow-hidden ${
                        flyerTheme === 'clean' 
                          ? 'bg-gray-100' 
                          : session.isFeatured
                            ? 'bg-slate-900/80 border border-amber-500/40 glow-fuchsia'
                            : 'bg-gray-900/60 border border-white/5'
                      }`}>
                        {session.isFeatured && (
                          <span className="absolute top-1 right-1 bg-amber-500 text-slate-950 text-[5px] font-black uppercase tracking-wider px-1 rounded font-mono">
                            🌟 FEATURED PLACE
                          </span>
                        )}
                        <QrCode className={`w-28 h-28 ${
                          flyerTheme === 'clean' 
                            ? 'text-gray-950' 
                            : session.isFeatured
                              ? 'text-amber-400 animate-pulse' 
                              : 'text-white'
                        }`} />
                      </div>

                      <div>
                        <div className="text-[9px] font-mono tracking-widest uppercase">SCAN QR CODE</div>
                        <div className={`text-[11px] font-bold mt-1 font-mono ${
                          flyerTheme === 'clean' ? 'text-rose-600' : 'text-rose-400'
                        }`}>
                          sway.tips/{session.talentName.toLowerCase().replace(/\s+/g, '')}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* NFC Upgrade & Welcome Kits */}
            {activeTab === 'nfc' && (
              <motion.div
                key="nfc"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-6"
              >
                {/* Welcomes status progression */}
                <div className="bg-gray-950 p-5 rounded-2xl border border-gray-800 flex flex-col md:flex-row gap-5 justify-between items-center">
                  <div className="space-y-1 text-center md:text-left">
                    <div className="text-xs font-mono font-bold text-rose-400 uppercase tracking-widest flex items-center justify-center md:justify-start gap-1">
                      <Sparkles className="w-4.5 h-4.5 animate-pulse" /> Physical Creator Stand Progress
                    </div>
                    <h4 className="font-display text-base font-bold text-white">
                      Unlock Physical "Sway Tap Stand"
                    </h4>
                    <p className="text-xs text-gray-400 max-w-lg leading-relaxed">
                      Process your first <span className="text-rose-400 font-bold">$50.00</span> in tips, and we'll manufacture and mail you a heavy-duty acrylic booth sign embedded with real NFC pay-transmitters!
                    </p>
                  </div>
                  
                  <div className="w-full md:w-56 text-right space-y-1.5">
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-gray-500">PROCESSED</span>
                      <span className="text-white font-bold">${currentEarnings} / $50</span>
                    </div>
                    <div className="w-full h-2.5 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
                      <div 
                        style={{ width: `${kitProgressPercent}%` }}
                        className="h-full bg-gradient-to-r from-rose-500 to-indigo-500 rounded-full transition-all duration-700"
                      ></div>
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {kitProgressPercent >= 100 
                        ? "🎉 UNLOCKED! We've dispatched your order." 
                        : `Next milestone: $${50 - currentEarnings} to lock in free stand!`
                      }
                    </div>
                  </div>
                </div>

                {/* Simulated NFC standalone test box */}
                <div className="grid md:grid-cols-2 gap-8 items-center pt-2">
                  <div className="space-y-4">
                    <h3 className="font-display text-lg font-bold text-white">
                      Simulate a Phone "NFC Tap"
                    </h3>
                    <p className="text-sm text-gray-300 leading-relaxed">
                      Physical items feature embedded tap-to-pay style NFC chips. When a patron holds their phone next to your acrylic stand or badge, it flashes open in their browser instantly—no camera required!
                    </p>

                    <div className="bg-gray-950 p-4 rounded-xl border border-gray-800">
                      <h4 className="text-xs font-bold text-white mb-2 flex items-center gap-2">
                        <Radio className="w-4 h-4 text-emerald-400 animate-pulse" /> Use the interactive simulator:
                      </h4>
                      <p className="text-xs text-gray-400 leading-relaxed">
                        Tap the phone illustration on the right to simulate a user placing their mobile device against a Sway Lanyard Stand.
                      </p>
                      
                      <button 
                        onClick={() => {
                          setShowNfcTapEffect(true);
                          setTimeout(() => {
                            setShowNfcTapEffect(false);
                            // Switch to Patron view
                            onClose();
                          }, 1800);
                        }}
                        disabled={showNfcTapEffect}
                        className="mt-3 w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800/20 disabled:text-emerald-500/60 text-white font-bold rounded-lg text-xs transition-all flex items-center justify-center gap-1.5"
                      >
                        {showNfcTapEffect ? "Tapping..." : "Simulate Tap Device"}
                      </button>
                    </div>
                  </div>

                  {/* High Quality Tap Animation */}
                  <div className="flex justify-center relative py-6 bg-gray-950/20 rounded-xl border border-gray-800/40">
                    
                    {/* Simulated Acrylic Base Badge Stand */}
                    <div className="w-48 h-60 bg-gradient-to-tr from-gray-900 to-gray-800 border border-white/10 rounded-2xl flex flex-col justify-between items-center p-4 shadow-xl select-none relative">
                      <div className="w-12 h-1.5 bg-gray-700 rounded mb-2"></div>
                      <div className="flex flex-col items-center">
                        <Radio className="w-10 h-10 text-rose-500 animate-pulse" />
                        <span className="text-8px font-mono tracking-widest text-rose-400 mt-2 font-bold uppercase">SWAY NFC STAND</span>
                      </div>
                      
                      <div className="text-[10px] text-gray-500 font-mono text-center">
                        <div>TAP PHONE HERE</div>
                        <div className="text-[7px]">TO REQUEST SONGS</div>
                      </div>
                      <div className="w-full text-center border-t border-white/5 pt-2 text-[9px] text-gray-400">
                        {session.talentName}
                      </div>

                      {/* Ripple visual effects on tap */}
                      {showNfcTapEffect && (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 rounded-2xl">
                          <motion.div 
                            initial={{ scale: 0.5, opacity: 0 }}
                            animate={{ scale: [1, 1.8, 2], opacity: [1, 0.5, 0] }}
                            transition={{ duration: 1.2, repeat: Infinity }}
                            className="absolute w-20 h-20 rounded-full border-2 border-emerald-500"
                          / >
                          <div className="text-center space-y-1">
                            <Smartphone className="w-8 h-8 text-emerald-400 mx-auto animate-bounce" />
                            <div className="text-[10px] font-bold text-emerald-400 tracking-wider">TAP DETECTED!</div>
                            <div className="text-[8px] text-gray-400">Loading Patron menu...</div>
                          </div>
                        </div>
                      )}
                    </div>
                    
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 bg-gray-950 border-t border-gray-800">
          <button 
            onClick={onClose}
            className="px-4 py-2 bg-gray-850 hover:bg-gray-800 text-gray-300 rounded-lg text-xs font-semibold border border-gray-700 hover:border-gray-600 transition-colors"
          >
            Dismiss Suite
          </button>
        </div>
      </motion.div>
    </div>
  );
}
