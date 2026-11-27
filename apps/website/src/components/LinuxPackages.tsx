"use client";

import { useEffect } from "react";
import { LINUX_PACKAGES } from "@/lib/platform";

export function ChevronIcon({ open, className = "size-5" }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`shrink-0 transition-transform duration-300 ${open ? "rotate-180" : ""} ${className}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Closes the drawer with Escape. */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
}

/**
 * A drawer that slides down with the Linux packages. Hidden from focus and
 * screen readers while closed. `compact` drops the format chip, for the
 * narrow download card.
 */
export function LinuxPackages({ id, open, compact = false, className = "" }: { id: string; open: boolean; compact?: boolean; className?: string }) {
  return (
    <div
      id={id}
      inert={!open}
      className={`grid w-full transition-[grid-template-rows,opacity] duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"} ${className}`}
    >
      <div className="overflow-hidden">
        <ul className="mt-3 flex flex-col gap-1 rounded-2xl border border-line bg-surface-raised/95 p-1.5 text-left shadow-[0_20px_50px_-20px_rgb(0_0_0/0.6)] backdrop-blur">
          {LINUX_PACKAGES.map(pkg => (
            <li key={pkg.id}>
              <a
                href={pkg.href}
                className="group flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-fill focus-visible:bg-fill sm:gap-3 sm:px-3 sm:py-2.5"
              >
                {compact ? (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono text-sm font-bold leading-tight text-brand-text">{pkg.ext}</span>
                    <span className="text-xs leading-snug text-ink-subtle">{pkg.hint}</span>
                  </span>
                ) : (
                  <>
                    <span className="grid h-9 w-[4.75rem] shrink-0 place-items-center rounded-lg bg-brand-soft font-mono text-[0.7rem] font-bold text-brand-text">
                      {pkg.ext}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-bold leading-tight text-ink">{pkg.label}</span>
                      <span className="truncate text-xs text-ink-subtle">{pkg.hint}</span>
                    </span>
                  </>
                )}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-5 shrink-0 text-ink-subtle transition-[color,transform] group-hover:translate-y-0.5 group-hover:text-brand-text">
                  <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
                </svg>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
