import { useEffect, useRef } from 'react';
import SwayMark from './SwayMark';

const EQ_BARS = Array.from({ length: 28 }, (_, i) => i);

export default function AppBackdrop() {
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    function handleTap(event: PointerEvent) {
      const bars = barRefs.current.filter((bar): bar is HTMLSpanElement => bar !== null);
      if (!bars.length) return;
      const maxDistance = Math.max(window.innerWidth * 0.6, 240);

      bars.forEach((bar) => {
        const rect = bar.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const distance = Math.abs(event.clientX - centerX);
        const strength = Math.max(0, 1 - distance / maxDistance);
        const scale = 1 + strength * 1.8;

        bar.style.transition = 'transform 100ms ease-out';
        bar.style.transform = `scaleY(${scale})`;
        window.setTimeout(() => {
          bar.style.transition = 'transform 500ms cubic-bezier(0.22, 1, 0.36, 1)';
          bar.style.transform = 'scaleY(1)';
        }, 120);
      });
    }

    window.addEventListener('pointerdown', handleTap);
    return () => window.removeEventListener('pointerdown', handleTap);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="grid-bg absolute inset-0" />

      <SwayMark glow={false} className="absolute left-1/2 top-1/2 h-[85vh] max-h-[900px] w-auto -translate-x-1/2 -translate-y-1/2 opacity-[0.05]" />

      <div className="absolute left-1/2 top-1/2 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fuchsia-600/20 blur-[150px]" />
      <div className="orb-drift absolute -top-40 left-[6%] h-[460px] w-[460px] rounded-full bg-fuchsia-600/45 blur-[110px]" />
      <div className="orb-drift-slow absolute top-1/4 -right-32 h-[420px] w-[420px] rounded-full bg-cyan-500/40 blur-[110px]" />
      <div className="orb-drift-reverse absolute bottom-1/4 left-[14%] h-[400px] w-[400px] rounded-full bg-violet-600/40 blur-[110px]" />
      <div className="orb-drift-slow absolute -bottom-28 right-[8%] h-[360px] w-[360px] rounded-full bg-pink-500/35 blur-[105px]" />

      <div className="absolute inset-x-0 bottom-0 flex h-40 items-end justify-center gap-1.5 opacity-50 [mask-image:linear-gradient(to_top,black,transparent)]">
        {EQ_BARS.map((i) => (
          <span
            key={i}
            ref={(el) => { barRefs.current[i] = el; }}
            className="eq-bar w-1.5 origin-bottom rounded-t-full bg-gradient-to-t from-fuchsia-500 to-cyan-300"
            style={{ animationDelay: `${(i % 7) * 0.15}s`, animationDuration: `${1.3 + (i % 5) * 0.2}s` }}
          />
        ))}
      </div>
    </div>
  );
}
