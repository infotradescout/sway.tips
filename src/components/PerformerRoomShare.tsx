import React, { useEffect, useState } from 'react';
import { QrCode } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

export function resolveLiveRoomLink(activeGigId: string | null) {
  if (!activeGigId) return null;
  if (typeof window === 'undefined') return `/g/${activeGigId}`;
  return new URL(`/g/${activeGigId}`, window.location.origin).toString();
}

function resolveLiveOverlayLink(activeGigId: string | null) {
  if (!activeGigId) return null;
  if (typeof window === 'undefined') return `/overlay/${activeGigId}`;
  return new URL(`/overlay/${activeGigId}`, window.location.origin).toString();
}

export async function copyRoomLink(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'absolute';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand('copy');
  document.body.removeChild(textArea);
}

export function PerformerRoomQr({ activeGigId, size }: { activeGigId: string | null; size: number }) {
  const roomLink = resolveLiveRoomLink(activeGigId);

  if (!roomLink) {
    return (
      <div
        aria-label="QR code appears after the room starts"
        className="flex aspect-square items-center justify-center bg-white text-slate-400"
      >
        <QrCode className="h-8 w-8" aria-hidden="true" />
      </div>
    );
  }

  return (
    <QRCodeCanvas
      value={roomLink}
      size={size}
      bgColor="#ffffff"
      fgColor="#000000"
      level="M"
      marginSize={1}
      title="Scan to open this live Sway room"
      className="h-auto w-full"
      data-sway-compact-room-qr="true"
    />
  );
}

export default function PerformerRoomShare({ activeGigId }: { activeGigId: string | null }) {
  const roomLink = resolveLiveRoomLink(activeGigId);
  const overlayLink = resolveLiveOverlayLink(activeGigId);
  const [copied, setCopied] = useState<'room' | 'overlay' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async (kind: 'room' | 'overlay', value: string | null) => {
    if (!value) return;
    await copyRoomLink(value);
    setCopied(kind);
  };

  return (
    <section
      data-sway-performer-room-share="true"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-900/90 p-3"
    >
      <div className="min-w-0">
        <h3 className="font-display text-xs font-black uppercase tracking-widest text-white">Share Room</h3>
        <p className="mt-1 truncate text-[11px] text-slate-400">
          {roomLink ? 'Show the code, copy the link, or open the room.' : 'Start a room to generate links.'}
        </p>
      </div>

      <div className="grid min-h-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 overflow-hidden rounded-xl border border-white/10 bg-slate-950 p-3">
        <div className="rounded-xl bg-white p-2">
          <div className="flex h-28 w-28 items-center justify-center bg-white text-slate-900">
            <PerformerRoomQr activeGigId={activeGigId} size={112} />
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-900 px-3 py-2">
            <p className="text-[9px] font-black uppercase tracking-widest text-cyan-300">Customer room</p>
            <p className="mt-1 truncate font-mono text-xs font-bold text-white">{roomLink ?? 'No live room yet'}</p>
          </div>
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-900 px-3 py-2">
            <p className="text-[9px] font-black uppercase tracking-widest text-fuchsia-300">Bigger screen</p>
            <p className="mt-1 truncate font-mono text-xs font-bold text-white">{overlayLink ?? 'No screen link yet'}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 landscape:grid-cols-4">
        <button type="button" onClick={() => handleCopy('room', roomLink)} disabled={!roomLink} className="min-h-10 rounded-xl bg-fuchsia-600 px-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">
          {copied === 'room' ? 'Copied' : 'Copy room'}
        </button>
        <a href={roomLink ?? undefined} target="_blank" rel="noreferrer" className={`flex min-h-10 items-center justify-center rounded-xl px-3 text-xs font-black ${roomLink ? 'border border-cyan-500/30 bg-cyan-500/10 text-cyan-200' : 'pointer-events-none border border-white/10 bg-slate-800 text-slate-500'}`}>
          Open room
        </a>
        <button type="button" onClick={() => handleCopy('overlay', overlayLink)} disabled={!overlayLink} className="min-h-10 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-black text-cyan-200 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-slate-800 disabled:text-slate-500">
          {copied === 'overlay' ? 'Copied' : 'Copy screen'}
        </button>
        <a href={overlayLink ?? undefined} target="_blank" rel="noreferrer" className={`flex min-h-10 items-center justify-center rounded-xl px-3 text-xs font-black ${overlayLink ? 'border border-cyan-500/30 bg-cyan-500/10 text-cyan-200' : 'pointer-events-none border border-white/10 bg-slate-800 text-slate-500'}`}>
          Open screen
        </a>
      </div>
    </section>
  );
}
