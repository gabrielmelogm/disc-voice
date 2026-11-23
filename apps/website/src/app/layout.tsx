import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { DETECT_PLATFORM_SCRIPT } from "@/lib/platform";
import "./globals.css";

const jakarta = localFont({
  src: "./fonts/PlusJakartaSans-latin.woff2",
  weight: "200 800",
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Disc Voice — Seu espaço para amigos e comunidades",
  description: "Crie servidores, converse por voz com seus amigos e compartilhe a tela. Baixe o Disc Voice para Windows e Linux.",
  openGraph: {
    title: "Disc Voice",
    description: "Crie servidores, converse por voz com seus amigos e compartilhe a tela.",
    type: "website",
    locale: "pt_BR",
  },
};

export const viewport: Viewport = {
  themeColor: "#14111c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-os is set by the script below before React hydrates.
    <html lang="pt-BR" className={jakarta.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DETECT_PLATFORM_SCRIPT }} />
        <noscript>
          <style>{".reveal{opacity:1!important;transform:none!important}"}</style>
        </noscript>
      </head>
      <body>{children}</body>
    </html>
  );
}
