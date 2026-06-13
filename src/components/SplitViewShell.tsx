import type { ReactNode } from 'react';

type SplitViewShellProps = {
  title: string;
  eyebrow?: string;
  primaryLabel: string;
  secondaryLabel: string;
  primary: ReactNode;
  secondary: ReactNode;
  emptyState?: ReactNode;
  isEmpty?: boolean;
  badge?: ReactNode;
};

export default function SplitViewShell({
  title,
  eyebrow,
  primaryLabel,
  secondaryLabel,
  primary,
  secondary,
  emptyState,
  isEmpty = false,
  badge
}: SplitViewShellProps) {
  return (
    <section
      className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)] lg:items-start lg:py-5"
      aria-label={`${title}: ${primaryLabel}`}
    >
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {eyebrow && <p className="text-[10px] font-black uppercase tracking-widest text-fuchsia-300">{eyebrow}</p>}
            <h1 className="font-display text-lg font-black uppercase tracking-wide text-white">{title}</h1>
          </div>
          {badge}
        </div>
        <div className="sr-only rounded-xl border border-white/10 bg-slate-950/40 p-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 lg:not-sr-only">
          {primaryLabel}
        </div>
        <div className="min-w-0">{isEmpty && emptyState ? emptyState : primary}</div>
      </div>

      <aside className="min-w-0 lg:sticky lg:top-4">
        <div className="rounded-xl border border-white/10 bg-slate-900/75 p-4 shadow-xl">
          <div className="sr-only mb-3 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 lg:not-sr-only">
            {secondaryLabel}
          </div>
          {secondary}
        </div>
      </aside>
    </section>
  );
}
