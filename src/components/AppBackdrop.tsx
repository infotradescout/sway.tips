export const SWAY_S_ONLY_BACKGROUND_SRC = '/assets/sway-s-only-no-text-background.png';

export default function AppBackdrop() {
  return (
    <div className="landing-backdrop pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="landing-aurora-field absolute" />
      <img
        className="landing-bg-art absolute left-1/2 top-1/2"
        src={SWAY_S_ONLY_BACKGROUND_SRC}
        alt=""
        width={1024}
        height={1536}
        loading="eager"
        decoding="async"
        fetchPriority="high"
      />
      <div className="landing-wave-ribbon absolute" />
      <div className="landing-neon-breathe absolute" />
      <div className="landing-light-sweep absolute" />
      <div className="landing-particles absolute" />
      <div className="landing-glow absolute inset-x-0 bottom-0" />
      <div className="landing-vignette absolute inset-0" />
    </div>
  );
}
