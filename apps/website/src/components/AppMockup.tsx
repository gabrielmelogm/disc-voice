import type { CSSProperties } from "react";
import Image from "next/image";
import icon from "@/app/icon.png";

const z = (depth: number) => ({ "--z": depth }) as CSSProperties;

const PEOPLE = [
  { name: "Gabi", color: "bg-[#8f5cf0]", speaking: true },
  { name: "Lucas", color: "bg-[#1fb5a3]", speaking: false },
  { name: "Marina", color: "bg-[#e0598b]", speaking: true },
  { name: "Rafa", color: "bg-[#f0b232]", speaking: false },
];

function Avatar({ name, color, speaking, size = "size-7" }: { name: string; color: string; speaking?: boolean; size?: string }) {
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-full text-[0.65rem] font-bold text-white ${color} ${speaking ? "animate-pulse-ring ring-2 ring-online" : ""}`}>
      {name[0]}
    </span>
  );
}

function Equalizer({ bars = 5, className = "" }: { bars?: number; className?: string }) {
  return (
    <span className={`flex h-4 items-center gap-[3px] ${className}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className="animate-eq h-full w-[3px] origin-center rounded-full bg-current" style={{ animationDelay: `${i * -0.17}s` }} />
      ))}
    </span>
  );
}

/** A stylized Disc Voice window floating in 3D, with UI pieces at different depths. */
export function AppMockup() {
  return (
    <div className="scene relative mx-auto w-full max-w-[640px] select-none" aria-hidden="true">
      <div className="stage relative">
        {/* Glow behind the window */}
        <div className="layer absolute -inset-10 rounded-[3rem] bg-brand/50 blur-3xl" style={z(-120)} />

        {/* App window */}
        <div className="layer relative flex aspect-[16/11] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-[0_40px_120px_-20px_rgb(0_0_0/0.8)]" style={z(0)}>
          {/* Server rail */}
          <div className="flex w-12 flex-col items-center gap-2.5 bg-surface-sunken py-3 sm:w-16">
            <span className="grid size-8 place-items-center rounded-xl bg-brand sm:size-10">
              <Image src={icon} alt="" width={40} height={40} className="size-full rounded-xl" />
            </span>
            <span className="h-px w-6 bg-line" />
            {["bg-[#1fb5a3]", "bg-[#e0598b]", "bg-[#f0b232]", "bg-fill"].map((color, i) => (
              <span key={i} className={`size-8 rounded-full sm:size-10 ${color} ${i === 0 ? "rounded-xl ring-2 ring-white/70" : ""}`} />
            ))}
          </div>

          {/* Channels */}
          <div className="hidden w-40 flex-col gap-1 border-r border-line bg-surface p-3 text-[0.7rem] sm:flex">
            <p className="mb-2 font-extrabold text-ink">Os Amigos</p>
            <p className="text-ink-subtle"># geral</p>
            <p className="text-ink-subtle"># memes</p>
            <p className="mt-2 rounded-md bg-fill px-1.5 py-1 font-semibold text-ink">🔊 Sala de voz</p>
            <div className="ml-2 flex flex-col gap-1.5 pt-1">
              {PEOPLE.map(person => (
                <span key={person.name} className="flex items-center gap-1.5 text-ink-muted">
                  <Avatar {...person} size="size-4" speaking={false} />
                  {person.name}
                  {person.speaking && <Equalizer bars={3} className="ml-auto h-2.5 text-online" />}
                </span>
              ))}
            </div>
            <p className="mt-2 text-ink-subtle">🔊 Jogatina</p>
          </div>

          {/* Call */}
          <div className="flex flex-1 flex-col bg-video-bg p-2.5 sm:p-3">
            <div className="grid flex-1 grid-cols-3 grid-rows-2 gap-2">
              <div className="relative col-span-2 row-span-2 overflow-hidden rounded-lg bg-gradient-to-br from-[#241a3a] to-video-surface p-3">
                <div className="flex gap-1.5">
                  <span className="size-1.5 rounded-full bg-danger" />
                  <span className="size-1.5 rounded-full bg-idle" />
                  <span className="size-1.5 rounded-full bg-online" />
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  {[70, 45, 85, 30, 60, 50, 75].map((width, i) => (
                    <span key={i} className={`h-1.5 rounded-full ${i % 3 === 0 ? "bg-brand-text/70" : "bg-white/15"}`} style={{ width: `${width}%`, marginLeft: `${(i % 3) * 8}%` }} />
                  ))}
                </div>
                <span className="absolute bottom-2 left-2 rounded bg-black/50 px-1.5 py-0.5 text-[0.6rem] font-semibold text-white">Gabi · tela</span>
              </div>
              {PEOPLE.slice(1, 3).map(person => (
                <div key={person.name} className={`relative grid place-items-center rounded-lg bg-video-surface ${person.speaking ? "ring-2 ring-online" : ""}`}>
                  <Avatar {...person} size="size-8 sm:size-10" speaking={false} />
                  <span className="absolute bottom-1.5 left-1.5 text-[0.55rem] font-semibold text-on-brand/80">{person.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Floating notification */}
        <div className="layer absolute -right-3 -top-6 sm:-right-10" style={z(140)}>
          <div className="animate-float flex items-center gap-3 rounded-2xl border border-white/10 bg-surface-raised/95 px-4 py-3 shadow-2xl backdrop-blur">
            <Avatar name="Gabi" color="bg-[#8f5cf0]" size="size-9" />
            <div className="text-xs">
              <p className="font-bold text-ink">Gabi entrou na sala</p>
              <p className="text-ink-subtle">🔊 Sala de voz · agora</p>
            </div>
          </div>
        </div>

        {/* Floating screen share pill */}
        <div className="layer absolute -left-4 top-1/3 sm:-left-12" style={z(180)}>
          <div className="animate-float flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-on-brand shadow-[0_18px_40px_-8px_rgb(100_16_201/0.9)] [animation-delay:-2.5s]">
            <span className="size-2 rounded-full bg-white" />
            Compartilhando tela
          </div>
        </div>

        {/* Floating call controls */}
        <div className="layer absolute -bottom-7 left-1/2 -translate-x-1/2" style={z(100)}>
          <div className="animate-float flex items-center gap-2 rounded-2xl border border-white/10 bg-surface-raised/95 p-2 shadow-2xl backdrop-blur [animation-delay:-4s]">
            <span className="grid size-9 place-items-center rounded-xl bg-fill text-online"><Equalizer bars={4} /></span>
            <span className="grid size-9 place-items-center rounded-xl bg-fill text-ink">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
            </span>
            <span className="grid size-9 place-items-center rounded-xl bg-danger text-white">
              <svg viewBox="0 0 24 24" className="size-4" fill="currentColor"><path d="M12 9c-3.5 0-6.6 1.2-8.7 3.1-.4.4-.4 1 0 1.4l1.6 1.6c.4.4 1 .4 1.4.1l2-1.5c.3-.2.4-.5.4-.8V11c1-.3 2.1-.5 3.3-.5s2.3.2 3.3.5v1.9c0 .3.1.6.4.8l2 1.5c.4.3 1 .3 1.4-.1l1.6-1.6c.4-.4.4-1 0-1.4C18.6 10.2 15.5 9 12 9z" /></svg>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
