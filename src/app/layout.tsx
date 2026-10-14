import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { TraceForgeExperience } from "@/components/traceforge-experience";
import { getSiteConfig, site } from "@/config/site";
import { serializeStructuredData, websiteStructuredData } from "@/lib/seo";
import "./globals.css";
import "./traceforge-theme.css";

const serif = localFont({ src: "../../public/fonts/InstrumentSerif-Regular.ttf", variable: "--font-serif", display: "swap", weight: "400" });
const sans = localFont({ src: "../../public/fonts/Manrope-Variable.ttf", variable: "--font-manrope", display: "swap", weight: "200 800" });
const themeBootstrap = "try{var t=localStorage.getItem('traceforge-theme');document.documentElement.dataset.theme=t==='dark'||t==='light'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}";

export const metadata: Metadata = {
  metadataBase: getSiteConfig().url,
  applicationName: site.name,
  title: { default: `${site.name} | Follow the evidence`, template: `%s | ${site.name}` },
  description: site.description,
  category: "technology",
  robots: { index: getSiteConfig().indexable, follow: getSiteConfig().indexable },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#111319" },
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
      <html lang={site.language} className={`${serif.variable} ${sans.variable}`} suppressHydrationWarning>
      <head><script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <TraceForgeExperience>{children}</TraceForgeExperience>
        <script
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: serializeStructuredData(websiteStructuredData()) }}
        />
      </body>
    </html>
  );
}
