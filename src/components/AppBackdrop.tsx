export default function AppBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="grid-bg absolute inset-0" />
      <div className="orb-drift absolute -top-40 left-[8%] h-[420px] w-[420px] rounded-full bg-fuchsia-600/30 blur-[110px]" />
      <div className="orb-drift-slow absolute top-1/3 -right-24 h-[380px] w-[380px] rounded-full bg-cyan-500/25 blur-[110px]" />
      <div className="orb-drift-reverse absolute -bottom-32 left-1/4 h-[360px] w-[360px] rounded-full bg-violet-600/25 blur-[110px]" />
      <div className="orb-drift-slow absolute bottom-0 right-[12%] h-[300px] w-[300px] rounded-full bg-pink-500/20 blur-[100px]" />
    </div>
  );
}
