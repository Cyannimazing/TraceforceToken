import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { getSiteConfig, site } from "@/config/site";
import { serializeStructuredData, websiteStructuredData } from "@/lib/seo";
import "./globals.css";

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
    { media: "(prefers-color-scheme: dark)", color: "#0a0c10" },
    { media: "(prefers-color-scheme: light)", color: "#eff2ed" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={site.language}>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {children}
        <script
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: serializeStructuredData(websiteStructuredData()) }}
        />
      </body>
    </html>
  );
}
