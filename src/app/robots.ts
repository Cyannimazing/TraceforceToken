import type { MetadataRoute } from "next";
import { absoluteUrl, getSiteConfig } from "@/config/site";

export default function robots(): MetadataRoute.Robots {
  if (!getSiteConfig().indexable) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/investigate", "/investigations/", "/account/", "/admin/"] },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
