import type { Platform } from "@/lib/platform";

/** Simple single-color marks for each desktop platform. */
export function PlatformIcon({ platform, className = "size-6" }: { platform: Platform; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      {platform === "windows" && (
        <path d="M3 5.6 10.4 4.6v7H3zM11.4 4.4 21 3v8.6h-9.6zM3 12.6h7.4v7L3 18.5zM11.4 12.6H21V21l-9.6-1.3z" />
      )}
      {platform === "mac" && (
        <path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.5-3.7zM14.1 5.9c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.5 2.7-1.3z" />
      )}
      {platform === "linux" && (
        <>
          <path
            fillRule="evenodd"
            d="M5.5 12.5a6.5 8.5 0 1 0 13 0a6.5 8.5 0 1 0 -13 0ZM8.2 15a3.8 5 0 1 0 7.6 0a3.8 5 0 1 0 -7.6 0ZM9.2 8a1 1.1 0 1 0 2 0a1 1.1 0 1 0 -2 0ZM12.8 8a1 1.1 0 1 0 2 0a1 1.1 0 1 0 -2 0ZM10.8 10.2h2.4L12 11.8Z"
          />
          <ellipse cx="8" cy="21.4" rx="3" ry="1.3" />
          <ellipse cx="16" cy="21.4" rx="3" ry="1.3" />
        </>
      )}
    </svg>
  );
}
