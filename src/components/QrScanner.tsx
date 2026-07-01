import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { X } from 'lucide-react';

const ALLOWED_HOSTS = new Set(['sway.tips', 'www.sway.tips', 'app.sway.tips']);

function resolveScannedTarget(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.origin);
    if (ALLOWED_HOSTS.has(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

export default function QrScanner({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        tick();
      } catch {
        if (!cancelled) setError('Camera access was denied or is unavailable on this device.');
      }
    }

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code?.data) {
            const target = resolveScannedTarget(code.data);
            if (target) {
              window.location.href = target;
              return;
            }
          }
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    }

    start();

    return () => {
      cancelled = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <p className="font-display text-sm font-black uppercase tracking-widest text-white">Scan a room code</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/10 p-2 text-slate-300 hover:text-white"
          aria-label="Close scanner"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        <canvas ref={canvasRef} className="hidden" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="glow-fuchsia h-56 w-56 rounded-2xl border-2 border-fuchsia-400/70" />
        </div>
        {error ? (
          <div className="absolute inset-x-4 bottom-6 rounded-xl border border-white/10 bg-slate-900/90 p-4 text-center text-sm text-slate-200">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
