export const APPROVED_SWAY_LOGO_SRC = '/419c8589-e2ef-4199-8221-4794e7420df4.png';

export default function SwayMark({ className, glow = true }: { className?: string; glow?: boolean }) {
  void glow;
  return (
    <img
      src={APPROVED_SWAY_LOGO_SRC}
      alt=""
      aria-hidden="true"
      decoding="async"
      draggable={false}
      className={className}
    />
  );
}
