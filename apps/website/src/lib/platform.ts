export type Platform = "windows" | "mac" | "linux";
/** What the visitor runs: a desktop platform, a phone/tablet, or not detected (yet). */
export type Visitor = Platform | "mobile" | "unknown";

export const PLATFORM_ORDER: Platform[] = ["windows", "mac", "linux"];

const RELEASES = "https://github.com/gabrielmelogm/disc-voice/releases/latest";

/** Download links. Override them with NEXT_PUBLIC_DOWNLOAD_* at build time. */
export const PLATFORMS: Record<Platform, { name: string; detail: string; href: string }> = {
  windows: {
    name: "Windows",
    detail: "Windows 10 e 11 · instalador .exe",
    href: process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS || RELEASES,
  },
  mac: {
    name: "macOS",
    detail: "Apple Silicon e Intel · .dmg",
    href: process.env.NEXT_PUBLIC_DOWNLOAD_MAC || RELEASES,
  },
  linux: {
    name: "Linux",
    detail: "Pacotes .deb e .rpm",
    href: process.env.NEXT_PUBLIC_DOWNLOAD_LINUX || RELEASES,
  },
};

/**
 * Runs in <head> before the first paint and stores the visitor's system in
 * <html data-os>, so the right download is highlighted without a flash.
 * iPadOS reports "Macintosh", so touch support tells it apart from a Mac;
 * Android reports "Linux", so phones are checked first.
 */
export const DETECT_PLATFORM_SCRIPT = `(function(){try{var n=navigator,p=((n.userAgentData&&n.userAgentData.platform)||n.platform||"")+" "+n.userAgent,o="unknown";if(/android|iphone|ipad|ipod|mobile/i.test(p)||(/mac/i.test(p)&&n.maxTouchPoints>1))o="mobile";else if(/win/i.test(p))o="windows";else if(/mac/i.test(p))o="mac";else if(/linux|x11|cros|bsd/i.test(p))o="linux";document.documentElement.dataset.os=o}catch(e){}})();`;

export function readVisitor(): Visitor {
  const os = document.documentElement.dataset.os;
  return os === "windows" || os === "mac" || os === "linux" || os === "mobile" ? os : "unknown";
}
