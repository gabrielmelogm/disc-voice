"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { PLATFORMS, PLATFORM_ORDER, isAvailable, readVisitor, type Platform, type Visitor } from "@/lib/platform";
import { ChevronIcon, LinuxPackages, useEscape } from "./LinuxPackages";
import { PlatformIcon } from "./PlatformIcon";
import { TiltCard } from "./TiltCard";

const noChanges = () => () => {};

/** The visitor's system; "unknown" while rendering on the server. */
export function useVisitor(): Visitor {
  return useSyncExternalStore(noChanges, readVisitor, () => "unknown");
}

function DownloadIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
    </svg>
  );
}

/** "Alpha" or "Em breve" tag; nothing for stable platforms. */
function StatusBadge({ platform, className = "" }: { platform: Platform; className?: string }) {
  const { status } = PLATFORMS[platform];
  if (status === "stable") return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider ${className || (status === "alpha"
      ? "bg-warning-soft text-warning-text"
      : "bg-fill text-ink-subtle")}`}>
      {status === "alpha" ? "Alpha" : "Em breve"}
    </span>
  );
}

/** The hero call to action: one big button for the detected platform. */
export function HeroDownload() {
  const visitor = useVisitor();
  const detected = visitor !== "mobile" && visitor !== "unknown" ? visitor : null;
  const others = PLATFORM_ORDER.filter(platform => platform !== detected);
  const [linuxOpen, setLinuxOpen] = useState(false);
  const closeLinux = useCallback(() => setLinuxOpen(false), []);
  useEscape(linuxOpen, closeLinux);
  // Under the Linux button, or under the "Também disponível" row (where -mt-5
  // cancels the column gap while closed).
  const drawer = (className: string) => <LinuxPackages id="hero-linux-packages" open={linuxOpen} className={className} />;

  return (
    <div className="flex flex-col items-center gap-5 lg:items-start">
      {detected === "linux" ? (
        <div className="flex w-full max-w-md flex-col items-center lg:items-start">
          <button
            type="button"
            aria-expanded={linuxOpen}
            aria-controls="hero-linux-packages"
            onClick={() => setLinuxOpen(open => !open)}
            className="btn-3d group inline-flex items-center gap-4 rounded-2xl px-7 py-4 text-on-brand sm:px-9 sm:py-5"
          >
            <PlatformIcon platform="linux" className="size-8 shrink-0" />
            <span className="flex flex-col text-left">
              <span className="flex items-center gap-2 text-lg font-extrabold leading-tight sm:text-xl">
                Baixar para Linux
                <StatusBadge platform="linux" className="bg-white/20 text-white" />
              </span>
              <span className="text-sm font-medium text-white/75">{PLATFORMS.linux.detail}</span>
            </span>
            <ChevronIcon open={linuxOpen} className="ml-2 size-6" />
          </button>
          {drawer("max-w-md")}
        </div>
      ) : detected && !isAvailable(detected) ? (
        <div className="inline-flex cursor-not-allowed items-center gap-4 rounded-2xl border border-line bg-surface-raised px-7 py-4 text-ink-subtle sm:px-9 sm:py-5">
          <PlatformIcon platform={detected} className="size-8 shrink-0" />
          <span className="flex flex-col text-left">
            <span className="flex items-center gap-2 text-lg font-extrabold leading-tight text-ink-muted sm:text-xl">
              {PLATFORMS[detected].name} <StatusBadge platform={detected} />
            </span>
            <span className="text-sm font-medium">{PLATFORMS[detected].detail}</span>
          </span>
        </div>
      ) : detected ? (
        <a href={PLATFORMS[detected].href} className="btn-3d group inline-flex items-center gap-4 rounded-2xl px-7 py-4 text-on-brand sm:px-9 sm:py-5">
          <PlatformIcon platform={detected} className="size-8 shrink-0" />
          <span className="flex flex-col text-left">
            <span className="flex items-center gap-2 text-lg font-extrabold leading-tight sm:text-xl">
              Baixar para {PLATFORMS[detected].name}
              <StatusBadge platform={detected} className="bg-white/20 text-white" />
            </span>
            <span className="text-sm font-medium text-white/75">{PLATFORMS[detected].detail}</span>
          </span>
          <DownloadIcon className="ml-2 size-6 shrink-0 transition-transform group-hover:translate-y-0.5" />
        </a>
      ) : (
        <a href="#download" className="btn-3d group inline-flex items-center gap-3 rounded-2xl px-8 py-5 text-lg font-extrabold text-on-brand sm:text-xl">
          <DownloadIcon className="size-6" />
          Baixar o Disc Voice
        </a>
      )}

      {visitor === "mobile" && (
        <p className="max-w-sm text-center text-sm text-ink-muted lg:text-left">
          O Disc Voice é um app para computador. Abra esta página no seu PC para baixar.
        </p>
      )}

      <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-ink-subtle lg:justify-start">
        <span>{detected && isAvailable(detected) ? "Também disponível para" : "Disponível para"}</span>
        {others.map(platform => platform === "linux" ? (
          <button
            key={platform}
            type="button"
            aria-expanded={linuxOpen}
            aria-controls="hero-linux-packages"
            onClick={() => setLinuxOpen(open => !open)}
            className="inline-flex items-center gap-1.5 font-semibold text-ink-muted transition-colors hover:text-brand-text"
          >
            <PlatformIcon platform={platform} className="size-4" />
            {PLATFORMS[platform].name}
            <StatusBadge platform={platform} />
            <ChevronIcon open={linuxOpen} className="size-4" />
          </button>
        ) : isAvailable(platform) ? (
          <a key={platform} href={PLATFORMS[platform].href} className="inline-flex items-center gap-1.5 font-semibold text-ink-muted transition-colors hover:text-brand-text">
            <PlatformIcon platform={platform} className="size-4" />
            {PLATFORMS[platform].name}
            <StatusBadge platform={platform} />
          </a>
        ) : (
          <span key={platform} className="inline-flex items-center gap-1.5 font-semibold text-ink-subtle/70">
            <PlatformIcon platform={platform} className="size-4" />
            {PLATFORMS[platform].name}
            <StatusBadge platform={platform} />
          </span>
        ))}
      </p>
      {detected !== "linux" && drawer("-mt-5 max-w-md")}
    </div>
  );
}

function PlatformCard({ platform, detected }: { platform: Platform; detected: boolean }) {
  const { name, detail, href } = PLATFORMS[platform];
  const available = isAvailable(platform);
  // Only a platform that can be downloaded gets the highlight.
  const recommended = detected && available;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEscape(open, close);
  const buttonClass = `pop mt-7 inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 font-bold [--pop:40px] ${recommended
    ? "btn-3d text-on-brand"
    : "bg-fill text-ink transition-colors hover:bg-fill-hover"}`;
  return (
    <TiltCard
      max={recommended ? 8 : 12}
      className={`flex flex-col items-center rounded-3xl border p-8 text-center ${recommended
        ? "border-brand-text/40 bg-gradient-to-b from-brand-soft to-surface shadow-[0_30px_80px_-20px_rgb(100_16_201/0.7)] md:-translate-y-4 lg:scale-105"
        : available ? "border-line bg-surface/80 hover:border-fill-hover" : "border-line/60 bg-surface/40"}`}
    >
      {recommended && (
        <span className="pop absolute -top-3.5 rounded-full bg-brand px-3.5 py-1 text-xs font-bold tracking-wide text-on-brand shadow-lg [--pop:60px]">
          Detectamos seu sistema
        </span>
      )}
      <div className={`pop mb-5 grid size-20 place-items-center rounded-2xl [--pop:50px] ${recommended
        ? "bg-brand text-on-brand shadow-[0_14px_30px_-6px_rgb(100_16_201/0.8)]"
        : available ? "bg-fill text-ink" : "bg-fill/60 text-ink-subtle"}`}>
        <PlatformIcon platform={platform} className="size-10" />
      </div>
      <h3 className={`pop flex items-center gap-2 text-2xl font-extrabold [--pop:30px] ${available ? "" : "text-ink-muted"}`}>
        {name}
        <StatusBadge platform={platform} />
      </h3>
      <p className="pop mt-1 text-sm text-ink-subtle [--pop:20px]">{detail}</p>
      {platform === "linux" ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="card-linux-packages"
            onClick={() => setOpen(value => !value)}
            className={buttonClass}
          >
            <DownloadIcon />
            Baixar
            <span className="sr-only"> para {name}</span>
            <ChevronIcon open={open} className="size-4" />
          </button>
          <LinuxPackages id="card-linux-packages" open={open} compact />
        </>
      ) : available ? (
        <a
          href={href}
          className={buttonClass}
        >
          <DownloadIcon />
          Baixar
          <span className="sr-only"> para {name}</span>
        </a>
      ) : (
        <button
          type="button"
          disabled
          className="pop mt-7 inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-dashed border-line px-5 py-3.5 font-bold text-ink-subtle [--pop:40px]"
        >
          Em breve
        </button>
      )}
    </TiltCard>
  );
}

/** One card per platform; the visitor's own system stands out. */
export function DownloadCards() {
  const visitor = useVisitor();
  return (
    // items-start: the Linux card grows when its drawer opens, the others stay put.
    <div className="grid items-start gap-6 md:grid-cols-3 md:gap-8">
      {PLATFORM_ORDER.map(platform => (
        <PlatformCard key={platform} platform={platform} detected={platform === visitor} />
      ))}
    </div>
  );
}
