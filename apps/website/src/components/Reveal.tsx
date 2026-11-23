"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";

/** Fades its content in from depth the first time it scrolls into view. */
export function Reveal({ delay = 0, className = "", style, children, ...props }: ComponentPropsWithoutRef<"div"> & { delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Content already on screen (the hero) shows right away.
    const inView = element.getBoundingClientRect().top < window.innerHeight * 0.9;
    if (inView || typeof IntersectionObserver === "undefined") { element.dataset.visible = "true"; return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      element.dataset.visible = "true";
      observer.disconnect();
    }, { rootMargin: "0px 0px -10% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${className}`} style={{ ...style, ["--delay" as string]: `${delay}ms` }} {...props}>
      {children}
    </div>
  );
}
