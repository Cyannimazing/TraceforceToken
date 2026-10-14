"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

function subscribe(listener: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => {
    try {
      const saved = localStorage.getItem("traceforge-theme");
      document.documentElement.dataset.theme = saved === "dark" || saved === "light" ? saved : media.matches ? "dark" : "light";
    } catch { document.documentElement.dataset.theme = media.matches ? "dark" : "light"; }
    listener();
  };
  window.addEventListener("storage", sync);
  window.addEventListener("traceforge-theme", listener);
  media.addEventListener("change", sync);
  return () => { window.removeEventListener("storage", sync); window.removeEventListener("traceforge-theme", listener); media.removeEventListener("change", sync); };
}
const snapshot = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => "system");
  const dark = theme === "dark";
  function toggle() {
    const next = snapshot() === "dark" ? "light" : "dark";
    try { localStorage.setItem("traceforge-theme", next); } catch { /* Preference remains valid for this page when storage is denied. */ }
    document.documentElement.dataset.theme = next;
    window.dispatchEvent(new Event("traceforge-theme"));
  }
  return <button type="button" onClick={toggle} className="tf-icon-button tf-theme-toggle" aria-label={theme === "system" ? "Change color theme" : `Switch to ${dark ? "light" : "dark"} mode`} title="Change color theme">{dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}</button>;
}
