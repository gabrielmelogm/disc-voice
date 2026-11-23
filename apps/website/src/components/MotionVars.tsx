"use client";

import { useEffect } from "react";

/**
 * Writes the pointer position and scroll offset to CSS variables on <html>
 * (--mx, --my, --scroll, --sp). CSS turns them into the 3D and parallax
 * transforms, so moving the mouse never re-renders React.
 */
export function MotionVars() {
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let pointerFrame = 0;
    let scrollFrame = 0;

    const write = (name: string, value: number) => root.style.setProperty(name, value.toFixed(4));

    const step = () => {
      current.x += (target.x - current.x) * 0.08;
      current.y += (target.y - current.y) * 0.08;
      write("--mx", current.x);
      write("--my", current.y);
      const moving = Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > 0.0005;
      pointerFrame = moving ? requestAnimationFrame(step) : 0;
    };
    const ease = () => { if (!pointerFrame) pointerFrame = requestAnimationFrame(step); };

    const onPointer = (event: PointerEvent) => {
      if (reduce.matches || event.pointerType === "touch") return;
      target.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.y = (event.clientY / window.innerHeight) * 2 - 1;
      ease();
    };
    const onLeave = () => { target.x = 0; target.y = 0; ease(); };

    const updateScroll = () => {
      scrollFrame = 0;
      const y = reduce.matches ? 0 : window.scrollY;
      write("--scroll", y);
      write("--sp", Math.min(y / Math.max(window.innerHeight, 1), 1));
    };
    const onScroll = () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll); };

    const onMotionPreference = () => { onLeave(); updateScroll(); };

    updateScroll();
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    reduce.addEventListener("change", onMotionPreference);
    return () => {
      cancelAnimationFrame(pointerFrame);
      cancelAnimationFrame(scrollFrame);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      reduce.removeEventListener("change", onMotionPreference);
    };
  }, []);

  return null;
}
