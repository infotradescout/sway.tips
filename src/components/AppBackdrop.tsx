export const SWAY_BACKGROUND_SRC = '/assets/sway-neon-background.png';

export default function AppBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <img
        src={SWAY_BACKGROUND_SRC}
        alt=""
        width={1080}
        height={1620}
        loading="eager"
        decoding="async"
        fetchPriority="high"
        className="absolute left-0 top-0 h-full w-full object-cover"
        style={{ objectPosition: '50% 50%', transform: 'none' }}
      />
    </div>
  );
}
