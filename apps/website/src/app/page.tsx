import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import { AppMockup } from "@/components/AppMockup";
import { DownloadCards, HeroDownload } from "@/components/Download";
import { MotionVars } from "@/components/MotionVars";
import { Reveal } from "@/components/Reveal";
import { TiltCard } from "@/components/TiltCard";
import icon from "./icon.png";

const depth = (d: number) => ({ "--d": d }) as CSSProperties;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-6">
      {children}
    </svg>
  );
}

const FEATURES = [
  {
    title: "Servidores para cada turma",
    text: "Crie servidores com canais de texto e de voz e convide seus amigos com um link.",
    icon: <Icon><path d="M4 6h16M4 12h16M4 18h10" /></Icon>,
  },
  {
    title: "Voz clara, sem esforço",
    text: "Áudio de baixa latência com indicação de quem está falando, direto na sala.",
    icon: <Icon><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Icon>,
  },
  {
    title: "Compartilhe a tela",
    text: "Mostre um jogo, um código ou uma apresentação para a sala inteira em segundos.",
    icon: <Icon><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>,
  },
  {
    title: "Traga seus servidores do Discord",
    text: "Importe a estrutura dos seus servidores e veja a atividade dos seus amigos.",
    icon: <Icon><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></Icon>,
  },
  {
    title: "Saiba quem chegou",
    text: "Alertas quando alguém entra na sala de voz e sons discretos durante a chamada.",
    icon: <Icon><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" /></Icon>,
  },
  {
    title: "Do seu jeito",
    text: "Tema claro, escuro ou importe temas da comunidade com as suas cores.",
    icon: <Icon><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" /></Icon>,
  },
];

function Background() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="parallax absolute -left-40 -top-40 size-[36rem] rounded-full bg-brand/40 blur-[120px]" style={depth(1.4)} />
      <div className="parallax absolute -right-32 top-1/3 size-[28rem] rounded-full bg-[#8f5cf0]/25 blur-[110px]" style={depth(0.8)} />
      <div className="parallax absolute bottom-[-12rem] left-1/3 size-[30rem] rounded-full bg-brand-soft blur-[100px]" style={depth(0.5)} />
      <div className="grid-floor absolute inset-x-[-50%] top-[55%] h-[120%]" />
      {/* Specks at three depths */}
      {[
        { className: "left-[12%] top-[22%] size-1.5", d: 2.2 },
        { className: "left-[80%] top-[16%] size-2", d: 1.6 },
        { className: "left-[68%] top-[70%] size-1", d: 2.8 },
        { className: "left-[28%] top-[62%] size-2.5", d: 1.1 },
        { className: "left-[46%] top-[8%] size-1", d: 3 },
        { className: "left-[90%] top-[48%] size-1.5", d: 2 },
      ].map(({ className, d }, i) => (
        <span key={i} className={`parallax absolute rounded-full bg-brand-text/70 shadow-[0_0_12px_rgb(183_148_246)] ${className}`} style={depth(d)} />
      ))}
    </div>
  );
}

export default function Home() {
  return (
    <>
      <MotionVars />
      <Background />

      <header className="sticky top-0 z-50 border-b border-white/5 bg-page/70 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="#" className="flex items-center gap-2.5 font-extrabold tracking-tight">
            <Image src={icon} alt="" width={32} height={32} className="rounded-lg" priority />
            Disc Voice
          </a>
          <div className="flex items-center gap-1 text-sm font-semibold sm:gap-2">
            <a href="#recursos" className="hidden rounded-lg px-3 py-2 text-ink-muted transition-colors hover:text-ink sm:block">Recursos</a>
            <a href="#download" className="rounded-xl bg-brand px-4 py-2 text-on-brand transition-colors hover:bg-brand-hover">Baixar</a>
          </div>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-16 px-4 pb-24 pt-14 sm:px-6 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[1fr_1.1fr] lg:gap-10 lg:pb-16">
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand-text/25 bg-brand-soft/60 px-3.5 py-1.5 text-xs font-bold text-brand-text">
                <span className="size-1.5 rounded-full bg-online" />
                Grátis para Windows e Linux · macOS em breve
              </span>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="mt-6 text-5xl font-extrabold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
                Sua turma,
                <br />
                <span className="text-gradient">sua voz, sua tela.</span>
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-muted">
                Crie servidores, entre numa sala de voz com seus amigos e compartilhe a tela em um clique.
                Tudo num app leve, feito para ficar aberto o dia todo.
              </p>
            </Reveal>
            <Reveal delay={240} className="mt-10">
              <HeroDownload />
            </Reveal>
          </div>

          <Reveal delay={200} className="mt-6 px-4 sm:px-10 lg:mt-0 lg:px-0">
            <AppMockup />
          </Reveal>
        </section>

        {/* Features */}
        <section id="recursos" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-brand-text">Recursos</p>
            <h2 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">Tudo que a conversa precisa</h2>
            <p className="mt-4 text-lg text-ink-muted">Do papo rápido à noite inteira de jogatina, sem complicação.</p>
          </Reveal>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, i) => (
              <Reveal key={feature.title} delay={(i % 3) * 90}>
                <TiltCard className="h-full rounded-3xl border border-line bg-surface/80 p-7 backdrop-blur hover:border-brand-text/30">
                  <div className="pop grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand-text [--pop:50px]">{feature.icon}</div>
                  <h3 className="pop mt-6 text-xl font-bold [--pop:30px]">{feature.title}</h3>
                  <p className="pop mt-2 leading-relaxed text-ink-muted [--pop:15px]">{feature.text}</p>
                </TiltCard>
              </Reveal>
            ))}
          </div>
        </section>

        {/* Parallax statement */}
        <section className="relative overflow-hidden py-32" aria-label="Destaque">
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <p className="parallax absolute left-[-5%] top-6 whitespace-nowrap text-[9rem] font-extrabold leading-none text-white/[0.03] sm:text-[13rem]" style={depth(-0.6)}>
              voz · tela · amigos · voz · tela
            </p>
            <p className="parallax absolute bottom-4 right-[-5%] whitespace-nowrap text-[9rem] font-extrabold leading-none text-brand/10 sm:text-[13rem]" style={depth(0.5)}>
              servidores · salas · temas
            </p>
          </div>
          <Reveal className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
            <h2 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">
              Feito para ficar <span className="text-gradient">sempre aberto</span>, sem pesar no seu PC.
            </h2>
            <p className="mt-6 text-lg text-ink-muted">Entre com sua conta Google e pronto: seus servidores e amigos estão a um clique.</p>
          </Reveal>
        </section>

        {/* Download */}
        <section id="download" className="relative mx-auto max-w-5xl scroll-mt-20 px-4 pb-32 pt-12 sm:px-6">
          <Reveal className="mx-auto max-w-2xl text-center">
            <Image src={icon} alt="" width={88} height={88} className="mx-auto rounded-3xl shadow-[0_24px_60px_-10px_rgb(100_16_201/0.8)]" />
            <h2 className="mt-8 text-4xl font-extrabold tracking-tight sm:text-5xl">Baixe o Disc Voice</h2>
            <p className="mt-4 text-lg text-ink-muted">Grátis. Escolha seu sistema e chame a turma.</p>
          </Reveal>
          <Reveal delay={120} className="mt-16">
            <DownloadCards />
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-ink-subtle sm:flex-row sm:px-6">
          <span className="flex items-center gap-2 font-semibold text-ink-muted">
            <Image src={icon} alt="" width={20} height={20} className="rounded-md" />
            Disc Voice
          </span>
        </div>
      </footer>
    </>
  );
}
