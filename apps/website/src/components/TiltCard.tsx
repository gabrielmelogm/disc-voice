"use client";

import { useRef, type ComponentPropsWithoutRef } from "react";

/** A card that tilts toward the pointer with a soft glare. */
export function TiltCard({ className = "", max = 10, children, ...props }: ComponentPropsWithoutRef<"div"> & { max?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  function move(event: React.PointerEvent<HTMLDivElement>) {
    const card = ref.current;
    if (!card || event.pointerType === "touch" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = card.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    card.dataset.active = "true";
    card.style.setProperty("--ry", `${(x - 0.5) * max * 2}deg`);
    card.style.setProperty("--rx", `${(0.5 - y) * max * 2}deg`);
    card.style.setProperty("--gx", `${x * 100}%`);
    card.style.setProperty("--gy", `${y * 100}%`);
    card.style.setProperty("--lift", "-6px");
  }

  function leave() {
    const card = ref.current;
    if (!card) return;
    card.dataset.active = "false";
    for (const name of ["--rx", "--ry", "--lift"]) card.style.removeProperty(name);
  }

  return (
    <div ref={ref} onPointerMove={move} onPointerLeave={leave} className={`tilt relative ${className}`} {...props}>
      {children}
    </div>
  );
}
