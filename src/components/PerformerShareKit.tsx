import { Check, Copy, Link as LinkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sendShareLinkCopied } from '../shells/frictionClient';

const MISSING_CONTEXT_COPY = 'No active live session. Start a session to generate your room link.';
const ACTIVE_BODY_COPY = 'Copy this room link so patrons land in the right live room to Request, Tip, and Boost.';
const QR_UNAVAILABLE_COPY = 'QR display is not available yet. Use the room link for now. This share kit is link-only for now. Use the print-ready room link until dynamic QR generation is available.';

function resolveRoomLink(activeGigId: string | null) {
  if (!activeGigId) return null;

  if (typeof window === 'undefined') {
    return `/g/${activeGigId}`;
  }

  return new URL(`/g/${activeGigId}`, window.location.origin).toString();
}

export default function PerformerShareKit({ activeGigId }: { activeGigId: string | null }) {
  const roomLink = resolveRoomLink(activeGigId);
  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    if (!roomLink) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomLink);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = roomLink;
        textArea.setAttribute('readonly', 'true');
        textArea.style.position = 'absolute';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }

      setCopied(true);
      setCopyFeedback(null);
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
      setCopyFeedback('Copy failed. Select the room link and copy it manually.');
    }
  };

  return (
    <div className="rounded-2xl border border-fuchsia-500/20 bg-slate-900 p-5 shadow-lg shadow-fuchsia-950/20">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-display text-xs font-mono font-bold uppercase tracking-wider text-fuchsia-400">Live Room Share</h4>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            {roomLink ? ACTIVE_BODY_COPY : MISSING_CONTEXT_COPY}
          </p>
        </div>
        <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/10 p-2 text-fuchsia-300">
          <LinkIcon className="h-4 w-4" />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-white/10 bg-slate-950 px-3 py-3">
          <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Room link</p>
          <p data-share-kit-room-link="true" className={`mt-2 break-all text-xs font-semibold ${roomLink ? 'text-white' : 'text-slate-500'}`}>
            {roomLink ?? MISSING_CONTEXT_COPY}
          </p>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          disabled={!roomLink}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 py-3 text-xs font-bold text-white transition-all hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy room link'}
        </button>

        <p className="text-[10px] leading-relaxed text-slate-500">{copyFeedback ?? QR_UNAVAILABLE_COPY}</p>
      </div>
    </div>
  );
}
