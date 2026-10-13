"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribeToMotionPreference(listener: () => void) {
  const preference = window.matchMedia(motionQuery);
  preference.addEventListener("change", listener);
  return () => preference.removeEventListener("change", listener);
}
function reducedMotionSnapshot() { return window.matchMedia(motionQuery).matches; }
// Keep SSR and initial hydration still until the browser preference is known.
function serverMotionSnapshot() { return true; }

const EffectsContext = createContext({ paused: false, toggle: () => {} });

/** Shared user control for installed Aceternity effects; no network or storage. */
export function TraceMotionProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  return <EffectsContext.Provider value={{ paused, toggle: () => setPaused((value) => !value) }}>{children}</EffectsContext.Provider>;
}

export function useTraceMotion() {
  const preference = useContext(EffectsContext);
  const reduced = useSyncExternalStore(subscribeToMotionPreference, reducedMotionSnapshot, serverMotionSnapshot);
  return { ...preference, active: !preference.paused && !reduced, reduced };
}
