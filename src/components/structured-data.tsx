import { headers } from "next/headers";
import { serializeStructuredData } from "@/lib/seo";

export async function StructuredData({ value }: { value: unknown }) {
  return (
    <script
      type="application/ld+json"
      nonce={(await headers()).get("x-nonce") ?? undefined}
      dangerouslySetInnerHTML={{ __html: serializeStructuredData(value) }}
    />
  );
}
