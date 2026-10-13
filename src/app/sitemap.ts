import type { MetadataRoute } from "next";
import { absoluteUrl, getSiteConfig, publicRoutes } from "@/config/site";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!getSiteConfig().indexable) return [];
  return publicRoutes.map((path) => ({ url: absoluteUrl(path) }));
}
