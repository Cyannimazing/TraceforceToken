"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { VisualEffectsToggle } from "./visual-effects-toggle";
import { TraceForgeMark } from "./traceforge-brand";

export type NavigationSection = "home" | "scan" | "methodology" | "sources";
export function TraceForgeNavigation({ active }: { active?: NavigationSection }) {
  const [open, setOpen] = useState(false);
  return <header className="tf-site-header"><div className="tf-header-inner">
    <Link href="/" className="tf-brand" aria-label="TraceForge home" onClick={() => setOpen(false)}><TraceForgeMark /><span>TraceForge<span className="tf-brand-period">.</span></span></Link>
    <nav id="primary-navigation" aria-label="Main navigation" className="tf-main-nav" data-open={open}>{[
      { href: "/investigate", label: "Investigate", id: "scan" }, { href: "/methodology", label: "Methodology", id: "methodology" }, { href: "/data-sources", label: "Sources", id: "sources" },
    ].map((link) => <Link key={link.id} href={link.href} aria-current={active === link.id ? "page" : undefined} onClick={() => setOpen(false)}>{link.label}<span className="tf-nav-line" aria-hidden="true" /></Link>)}</nav>
    <div className="tf-header-actions"><span className="tf-network-status"><span aria-hidden="true" />Base</span><ThemeToggle /><VisualEffectsToggle /><button type="button" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls="primary-navigation" className="tf-icon-button tf-menu-toggle" onClick={() => setOpen((value) => !value)}>{open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}</button></div>
  </div></header>;
}
