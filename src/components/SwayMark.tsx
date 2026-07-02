import { useId } from 'react';

const S_PATH = 'M78 24C78 10 60 2 40 2C18 2 4 14 4 32C4 50 20 58 40 64C60 70 76 78 76 96C76 114 62 126 40 126C20 126 4 118 2 104';

export default function SwayMark({ className, glow = true }: { className?: string; glow?: boolean }) {
  const uid = useId();
  const gradientId = `sway-mark-gradient-${uid}`;
  const glowId = `sway-mark-glow-${uid}`;

  return (
    <svg viewBox="-20 -20 120 166" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e879f9" />
          <stop offset="50%" stopColor="#f0abfc" />
          <stop offset="100%" stopColor="#67e8f9" />
        </linearGradient>
        {glow ? (
          <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ) : null}
      </defs>
      <path
        d={S_PATH}
        stroke={`url(#${gradientId})`}
        strokeWidth="14"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={glow ? `url(#${glowId})` : undefined}
      />
    </svg>
  );
}
