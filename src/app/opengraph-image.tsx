import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "TraceForge — follow the evidence. On-chain investigation, starting on Base.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const mark = await readFile(join(process.cwd(), "public/brand/icon-192.png"));
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#f7f6f2", color: "#242731", padding: "56px 66px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, fontWeight: 700 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Rendered into a PNG, not browser HTML. */}
          <img src={`data:image/png;base64,${mark.toString("base64")}`} width={72} height={72} alt="" />
          TRACEFORGE
        </div>
        <div style={{ display: "flex", color: "#315bd9", fontSize: 18 }}>BASE / ON-CHAIN INTELLIGENCE</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", fontSize: 90, lineHeight: 1.05, fontWeight: 700, letterSpacing: "-4px" }}>
        <div style={{ display: "flex" }}>Follow the money.</div>
        <div style={{ display: "flex", color: "#315bd9" }}>Reconstruct the story.</div>
      </div>
      <div style={{ display: "flex", fontSize: 23, color: "#616773", borderTop: "1px solid #dce0e7", paddingTop: 28 }}>Funding trails · Wallet connections · Accumulation · Selling evidence</div>
    </div>,
    size,
  );
}
