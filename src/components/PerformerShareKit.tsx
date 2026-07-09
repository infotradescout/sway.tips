import { Check, Copy, Download, ExternalLink, Link as LinkIcon, Printer, QrCode } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { sendShareLinkCopied } from '../shells/frictionClient';

const MISSING_CONTEXT_COPY = 'No active live session. Create a room to generate your room link and QR code.';
const ACTIVE_BODY_COPY = 'Patrons can scan this QR code or open this room link to land directly in your live Request, Tip, and Boost room.';
const ACTIVE_HELP_COPY = 'This print-ready room link and QR sign stay tied to the selected live room. For streams, open the matching overlay route in a browser source manually.';
const DOWNLOAD_SUCCESS_COPY = 'QR sign downloaded. Print it on white paper for the clearest room scan.';
const PRINT_HINT_COPY = 'Print the QR sign or place it near the room so patrons land in the correct live queue.';
const QR_EMPTY_STATE_COPY = 'QR code appears here after you create a room.';

function resolveRoomLink(activeGigId: string | null) {
  if (!activeGigId) return null;

  if (typeof window === 'undefined') {
    return `/g/${activeGigId}`;
  }

  return new URL(`/g/${activeGigId}`, window.location.origin).toString();
}

function resolveOverlayLink(activeGigId: string | null) {
  if (!activeGigId) return null;

  if (typeof window === 'undefined') {
    return `/overlay/${activeGigId}`;
  }

  return new URL(`/overlay/${activeGigId}`, window.location.origin).toString();
}

export default function PerformerShareKit({ activeGigId }: { activeGigId: string | null }) {
  const roomLink = resolveRoomLink(activeGigId);
  const roomPath = activeGigId ? `/g/${activeGigId}` : null;
  const overlayLink = resolveOverlayLink(activeGigId);
  const overlayPath = activeGigId ? `/overlay/${activeGigId}` : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [overlayCopied, setOverlayCopied] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    if (!overlayCopied) return;
    const timeout = window.setTimeout(() => setOverlayCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [overlayCopied]);

  useEffect(() => {
    setCopied(false);
    setOverlayCopied(false);
    setShareFeedback(null);
  }, [activeGigId]);

  const copyToClipboard = async (value: string) => {
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
  };

  const handleCopy = async () => {
    if (!roomLink) return;

    try {
      await copyToClipboard(roomLink);
      setCopied(true);
      setShareFeedback(null);
      sendShareLinkCopied({
        shell: 'talent',
        surface: 'share-kit',
        route_family: 'talent-gigs',
        has_route_context: Boolean(activeGigId),
        has_session_context: Boolean(activeGigId),
        build_commit: 'unknown'
      });
    } catch {
      setCopied(false);
      setShareFeedback('Copy failed. Select the room link and copy it manually.');
    }
  };

  const handleCopyOverlay = async () => {
    if (!overlayLink) return;

    try {
      await copyToClipboard(overlayLink);
      setOverlayCopied(true);
      setShareFeedback(null);
    } catch {
      setOverlayCopied(false);
      setShareFeedback('Copy failed. Select the overlay link and copy it manually.');
    }
  };

  const handleDownload = () => {
    if (!roomLink || !canvasRef.current || !activeGigId) return;

    const downloadLink = document.createElement('a');
    downloadLink.href = canvasRef.current.toDataURL('image/png');
    downloadLink.download = `sway-room-${activeGigId}.png`;
    downloadLink.click();
    setShareFeedback(DOWNLOAD_SUCCESS_COPY);
  };

  const handlePrint = () => {
    if (!roomLink || !canvasRef.current) return;

    const imageUrl = canvasRef.current.toDataURL('image/png');
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) {
      setShareFeedback('Print popup blocked. Download the QR sign instead.');
      return;
    }

    printWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sway Live Room QR</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px;
        font-family: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
        background: #ffffff;
        color: #111111;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        border: 2px solid #111111;
        padding: 28px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 32px;
      }
      p {
        margin: 0 0 12px;
        line-height: 1.5;
      }
      .qr-wrap {
        display: flex;
        justify-content: center;
        padding: 20px;
        margin: 24px 0;
        border: 2px solid #111111;
        background: #ffffff;
      }
      img {
        width: min(100%, 360px);
        height: auto;
        image-rendering: pixelated;
      }
      .room-link {
        margin-top: 18px;
        padding: 12px;
        border: 1px solid #111111;
        word-break: break-all;
        font-weight: 700;
      }
    </style>
  </head>
  <body onload="window.print()">
    <main>
      <p>Sway Live Room</p>
      <h1>Scan to Join</h1>
      <p>Request, Tip, and Boost in the correct live room.</p>
      <div class="qr-wrap">
        <img src="${imageUrl}" alt="Sway live room QR code" />
      </div>
      <div class="room-link">${roomLink}</div>
    </main>
  </body>
</html>`);
    printWindow.document.close();
    setShareFeedback(PRINT_HINT_COPY);
  };

  return (
    <div className="rounded-2xl border border-fuchsia-500/20 bg-slate-900 p-5 shadow-lg shadow-fuchsia-950/20">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-display text-xs font-mono font-bold uppercase tracking-wider text-fuchsia-400">Show QR</h4>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            {roomLink ? ACTIVE_BODY_COPY : MISSING_CONTEXT_COPY}
          </p>
        </div>
        <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/10 p-2 text-fuchsia-300">
          {roomLink ? <QrCode className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {roomLink ? (
          <div className="rounded-2xl border border-fuchsia-500/30 bg-slate-950 p-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="text-[9px] font-mono uppercase tracking-widest text-fuchsia-300">Patron entry</p>
                <p data-share-kit-room-link="true" className="mt-2 break-all text-sm font-black text-white">
                  {roomLink}
                </p>
                <p className="mt-2 text-[10px] font-mono uppercase tracking-widest text-slate-500">
                  {roomPath ? `Live path: ${roomPath}` : 'Create a room to generate the patron route.'}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-3 shadow-inner" data-share-kit-room-qr="true">
                <QRCodeCanvas
                  key={roomLink}
                  ref={canvasRef}
                  aria-label="Live room QR code"
                  className="mx-auto h-auto max-w-full"
                  value={roomLink}
                  size={176}
                  level="H"
                  bgColor="#ffffff"
                  fgColor="#000000"
                  marginSize={4}
                />
              </div>
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-slate-400">{ACTIVE_HELP_COPY}</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950 px-4 py-5 text-left">
            <p className="text-xs font-bold text-white">{QR_EMPTY_STATE_COPY}</p>
            <div className="mt-4 grid gap-2 text-[10px] text-slate-400">
              <div className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2">
                <span className="font-mono uppercase tracking-widest text-slate-500">1. Set room settings</span>
                <p className="mt-1">Confirm the money settings before creating the room.</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2">
                <span className="font-mono uppercase tracking-widest text-slate-500">2. Create room</span>
                <p className="mt-1">Generate the patron link and QR for tonight.</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2">
                <span className="font-mono uppercase tracking-widest text-slate-500">3. Share QR</span>
                <p className="mt-1">Show the room code once the live route is generated.</p>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-slate-950 px-3 py-3">
          <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Stream / OBS overlay</p>
          <p className={`mt-2 break-all text-xs font-semibold ${overlayLink ? 'text-white' : 'text-slate-500'}`}>
            {overlayLink ?? 'Create a room to generate the stream overlay route.'}
          </p>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            {overlayPath
              ? 'Add this as an OBS/Streamlabs Browser Source, or open it directly on a phone or tablet (landscape) to use that device’s screen as your stream source.'
              : 'Overlay route appears here after the room goes live.'}
          </p>
          <button
            type="button"
            onClick={handleCopyOverlay}
            disabled={!overlayLink}
            className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-200 transition-all hover:border-cyan-400 hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-slate-800 disabled:text-slate-500"
          >
            {overlayCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {overlayCopied ? 'Copied' : 'Copy overlay link'}
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!roomLink}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 py-3 text-xs font-bold text-white transition-all hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy room link'}
          </button>

          <a
            href={roomLink ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!roomLink}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-xs font-bold transition-all ${
              roomLink
                ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:border-cyan-400 hover:text-white'
                : 'pointer-events-none cursor-not-allowed border-white/10 bg-slate-800 text-slate-500'
            }`}
          >
            <ExternalLink className="h-4 w-4" />
            Open patron room
          </a>
        </div>

        <a
          href={overlayLink ?? undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!overlayLink}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-xs font-bold transition-all ${
            overlayLink
              ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:border-cyan-400 hover:text-white'
              : 'pointer-events-none cursor-not-allowed border-white/10 bg-slate-800 text-slate-500'
          }`}
        >
          <ExternalLink className="h-4 w-4" />
          Open browser overlay
        </a>

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={handleDownload}
            disabled={!roomLink}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-xs font-bold text-white transition-all hover:border-fuchsia-400 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-slate-800 disabled:text-slate-500"
          >
            <Download className="h-4 w-4" />
            Download QR sign
          </button>

          <button
            type="button"
            onClick={handlePrint}
            disabled={!roomLink}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-xs font-bold text-white transition-all hover:border-fuchsia-400 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-slate-800 disabled:text-slate-500"
          >
            <Printer className="h-4 w-4" />
            Print QR sign
          </button>
        </div>

        <p className="text-[10px] leading-relaxed text-slate-500">{shareFeedback ?? PRINT_HINT_COPY}</p>
      </div>
    </div>
  );
}
