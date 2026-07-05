export const SWAY_BACKGROUND_SRC = '/assets/sway-neon-background.png';

export default function AppBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <img
        src={SWAY_BACKGROUND_SRC}
        alt=""
        className="h-full w-full object-cover"
      />
    </div>
  );
}
