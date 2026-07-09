/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { 
  Sparkles, 
  Share2, 
  TrendingUp, 
  Music, 
  Coins, 
  Users, 
  Award, 
  Instagram, 
  Check, 
  ArrowRight,
  Flame,
  AwardIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GigSession, RequestItem } from '../types';

interface VictoryScreenProps {
  session: GigSession;
  requests: RequestItem[];
  onRestart: () => void;
}

export default function VictoryScreen({ session, requests, onRestart }: VictoryScreenProps) {
  const [copiedStory, setCopiedStory] = useState(false);
  const [shareError, setShareError] = useState(false);
  const [selectedGradient, setSelectedGradient] = useState<'neon' | 'cyberpunk' | 'midnight'>('neon');

  const backersCount = requests
    .filter((request) => !request.hidden && !request.removed)
    .reduce((sum, request) => sum + Math.max(1, request.sponsorCount), 0);

  const formattedTips = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(session.totals.totalTips);
  const shareText = `I just wrapped a Sway night and pulled in ${formattedTips} in tips. www.sway.tips`;

  const handleShare = async () => {
    setShareError(false);
    try {
      if (navigator.share) {
        await navigator.share({ text: shareText, url: 'https://www.sway.tips' });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText);
        setCopiedStory(true);
        setTimeout(() => setCopiedStory(false), 2500);
      } else {
        throw new Error('Sharing is not supported in this browser.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('Unable to share recap:', error);
      setShareError(true);
      setTimeout(() => setShareError(false), 2500);
    }
  };

  const gradientStyles = {
    neon: 'from-rose-500 via-purple-600 to-indigo-600',
    cyberpunk: 'from-amber-400 via-rose-500 to-violet-600',
    midnight: 'from-blue-600 via-indigo-900 to-purple-950'
  };

  const cardVibeName = {
    neon: 'Neon Night Club',
    cyberpunk: 'Vaporwave Rave',
    midnight: 'Midnight Session'
  };

  return (
    <div id="victory_screen_container" className="min-h-screen py-10 px-4 bg-gray-950 flex flex-col items-center justify-center grid-bg">
      <div className="absolute inset-0 bg-gradient-to-t from-gray-950 via-gray-950/80 to-transparent pointer-events-none z-0"></div>

      <div className="w-full max-w-4xl relative z-10 grid md:grid-cols-2 gap-10 items-center">
        
        {/* Left column: Gamified statistics recap & rewards */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
          className="space-y-6"
        >
          <div className="flex items-center gap-2 text-rose-500 font-mono font-bold text-sm tracking-widest uppercase">
            <Flame className="w-4 h-4 animate-bounce" /> SHIFT COMPLETE
          </div>
          
          <h1 className="font-display text-4xl font-extrabold text-white tracking-tight leading-tight">
            Night recap
          </h1>
          
          <p className="text-gray-300 text-sm leading-relaxed">
            You ended the room. Totals below reflect requests, tips, boosts, and fees recorded for tonight.
          </p>

          {/* Gamified Stat Grid */}
          <div className="grid grid-cols-2 gap-4">
            
            {/* Total Tip Stats */}
            <div className="bg-gray-900/60 border border-gray-800 p-4 rounded-xl flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-emerald-500/15 text-emerald-400">
                <Coins className="w-5 h-5" id="victory_icon_tips" />
              </div>
              <div>
                <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Total Tips</div>
                <div className="text-xl font-bold font-display text-white mt-0.5">{formattedTips}</div>
              </div>
            </div>

            {/* Total Requests Fulfilled */}
            <div className="bg-gray-900/60 border border-gray-800 p-4 rounded-xl flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-rose-500/15 text-rose-400">
                <Award className="w-5 h-5" id="victory_icon_fulfilled" />
              </div>
              <div>
                <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Fulfilled requests</div>
                <div className="text-xl font-bold font-display text-white mt-0.5">{session.totals.totalCount} Requests</div>
              </div>
            </div>

            {/* Total Boost Spenders */}
            <div className="bg-gray-900/60 border border-gray-800 p-4 rounded-xl flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-indigo-500/15 text-indigo-400">
                <Users className="w-5 h-5" id="victory_icon_backers" />
              </div>
              <div>
                <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Backers</div>
                <div className="text-xl font-bold font-display text-white mt-5">{backersCount} {backersCount === 1 ? 'Sponsor' : 'Sponsors'}</div>
              </div>
            </div>

            {/* Platform Fees */}
            <div className="bg-gray-900/60 border border-gray-800 p-4 rounded-xl flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-cyan-500/15 text-cyan-400">
                <TrendingUp className="w-5 h-5" />
              </div>
              <div>
                <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Platform Fee</div>
                <div className="text-lg font-bold font-display text-white mt-0.5">${session.totals.accumulatedFees}.00</div>
              </div>
            </div>

          </div>

          {/* Top Requested Track */}
          <div className="p-4 bg-gradient-to-r from-gray-900 to-indigo-950/40 border border-indigo-900/30 rounded-xl space-y-1.5">
            <div className="text-[10px] text-indigo-400 font-mono font-bold uppercase tracking-wider flex items-center gap-1.5">
              <Music className="w-3.5 h-3.5 animate-pulse" /> Top requested item of the night:
            </div>
            <div className="text-base font-bold text-white font-display">
              {session.totals.topRequest}
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              This choice brought in the most crowd-funded boosts and topped your Approved Queue.
            </p>
          </div>

          <div className="pt-4 flex flex-col sm:flex-row gap-4">
            <button 
              onClick={onRestart}
              className="flex-1 py-3 px-5 bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-rose-500/20 flex items-center justify-center gap-2 group"
            >
              Start New Room <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
          </div>
        </motion.div>

        {/* Right column: Instagram / TikTok Social Story Card Mock */}
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="flex flex-col items-center space-y-4"
        >
          {/* Card Frame (9:16 aspect ratio) */}
          <div className="relative w-80 h-[510px] rounded-3xl overflow-hidden shadow-2xl transition-all duration-300 transform hover:scale-[1.01]">
            {/* The Gradient Canvas background */}
            <div className={`absolute inset-0 bg-gradient-to-tr ${gradientStyles[selectedGradient]} p-1`}>
              <div className="w-full h-full bg-gray-950/90 rounded-[22px] flex flex-col justify-between p-6 overflow-hidden relative">
                
                {/* Visual grid behind content */}
                <div className="absolute inset-0 bg-grid-bg opacity-[0.06] rounded-[22px]"></div>

                {/* Card Header */}
                <div className="flex justify-between items-center relative z-10">
                  <span className="font-display text-xs font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-rose-400 to-indigo-400 uppercase">
                    SWAY
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono uppercase flex items-center gap-1.5 bg-white/5 border border-white/5 px-2 py-0.5 rounded-full">
                    <Sparkles className="w-3 h-3 text-rose-400" /> {cardVibeName[selectedGradient]}
                  </span>
                </div>

                {/* Big Visual Circle (Total Tips) */}
                <div className="my-auto flex flex-col items-center justify-center text-center relative z-10 space-y-1">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-rose-500/10 to-indigo-500/10 border border-white/10 flex items-center justify-center mb-2 animate-pulse">
                    <AwardIcon className="w-10 h-10 text-rose-400" />
                  </div>
                  <div className="text-[11px] text-gray-400 font-mono uppercase tracking-widest leading-none">TOTAL TIPS</div>
                  <div className="text-5xl font-black font-display text-white tracking-tight mt-1">
                    {formattedTips}
                  </div>
                  <div className="text-xs text-rose-400 font-mono font-medium tracking-wide mt-2">
                    ROOM CLOSED SUCCESSFULLY
                  </div>
                </div>

                {/* Display item details inside social card */}
                <div className="relative z-10 bg-white/5 border border-white/5 rounded-xl p-4 mt-auto">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[8px] text-gray-500 uppercase font-mono">PERFORMER</div>
                      <div className="text-xs font-bold text-white truncate mt-0.5">{session.talentName}</div>
                      <div className="text-[8px] text-rose-400 tracking-wider font-mono uppercase mt-1">{session.talentRole}</div>
                    </div>
                    <div>
                      <div className="text-[8px] text-gray-500 uppercase font-mono">TOP REQUEST</div>
                      <div className="text-xs font-extrabold text-white truncate mt-0.5">{session.totals.topRequest}</div>
                      <div className="text-[8px] text-indigo-400 tracking-wider font-mono uppercase mt-1">Fulfillment Leader</div>
                    </div>
                  </div>
                </div>

                {/* Footer and taglines */}
                <div className="mt-4 flex justify-between items-center border-t border-white/5 pt-3 text-[8px] text-gray-500 font-mono relative z-10">
                  <span>WWW.SWAY.TIPS</span>
                  <span>TAP TO TIP ANYWHERE</span>
                </div>

              </div>
            </div>
          </div>

          {/* Social settings and sharing button */}
          <div className="w-full space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-400 font-semibold uppercase font-mono">Choose Card Vibe:</span>
              <div className="flex gap-1.5">
                {(['neon', 'cyberpunk', 'midnight'] as const).map((style) => (
                  <button
                    key={style}
                    onClick={() => setSelectedGradient(style)}
                    className={`w-4 h-4 rounded-full border transition-all ${
                      selectedGradient === style 
                        ? 'border-white ring-2 ring-rose-500/50 scale-110' 
                        : 'border-transparent hover:scale-105'
                    } ${
                      style === 'neon' 
                        ? 'bg-gradient-to-tr from-rose-500 to-indigo-600' 
                        : style === 'cyberpunk'
                          ? 'bg-gradient-to-tr from-amber-400 to-violet-600'
                          : 'bg-gradient-to-tr from-blue-600 to-purple-950'
                    }`}
                  />
                ))}
              </div>
            </div>

            <button
              onClick={handleShare}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-gray-900 hover:bg-gray-805 text-white border border-gray-800 rounded-xl text-xs font-bold transition-all hover:border-gray-750"
            >
              {copiedStory ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" /> Recap Copied — Paste it Into Your Story!
                </>
              ) : shareError ? (
                <>
                  <Instagram className="w-4 h-4 text-rose-400" /> Couldn't Share — Try Again
                </>
              ) : (
                <>
                  <Instagram className="w-4 h-4 text-pink-500" /> Share Recap to Instagram &amp; TikTok Stories
                </>
              )}
            </button>
          </div>

        </motion.div>

      </div>
    </div>
  );
}
