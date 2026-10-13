import type { Metadata } from "next";
import { absoluteUrl, getSiteConfig, site } from "@/config/site";

interface PageMetadata {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
}

export function createMetadata({ title, description, path, noIndex = false }: PageMetadata): Metadata {
  const index = getSiteConfig().indexable && !noIndex;
  const brandedTitle = `${title} | ${site.name}`;
  return {
    // A layout template does not apply to its own page; brand every route explicitly.
    title: { absolute: brandedTitle },
    description,
    alternates: { canonical: absoluteUrl(path) },
    robots: { index, follow: !noIndex && getSiteConfig().indexable },
    openGraph: {
      type: "website",
      title: brandedTitle,
      description,
      siteName: site.name,
      locale: site.locale,
      url: absoluteUrl(path),
      images: [{ url: absoluteUrl("/opengraph-image"), width: 1200, height: 630, alt: "TraceForce Engine — follow the evidence" }],
    },
    twitter: {
      card: "summary_large_image",
      title: brandedTitle,
      description,
      images: [{ url: absoluteUrl("/opengraph-image"), alt: "TraceForce Engine — follow the evidence" }],
    },
  };
}

export function websiteStructuredData() {
  const origin = absoluteUrl("/");
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": `${origin}#organization`, name: site.name, url: origin },
      {
        "@type": "WebSite",
        "@id": `${origin}#website`,
        name: site.name,
        url: origin,
        description: site.description,
        inLanguage: site.language,
        publisher: { "@id": `${origin}#organization` },
      },
    ],
  };
}

export function breadcrumbStructuredData(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

/** Escape '<' so data cannot terminate an HTML script element. */
export function serializeStructuredData(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
