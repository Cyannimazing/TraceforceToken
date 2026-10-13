import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "TraceForce Engine — follow the evidence. On-chain investigation, starting on Base.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const mark = await readFile(join(process.cwd(), "public/brand/traceforce-mark.png"));
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#050a12", color: "#e6f2f7", padding: "56px 66px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, fontWeight: 700 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Rendered into a PNG, not browser HTML. */}
          <img src={`data:image/png;base64,${mark.toString("base64")}`} width={72} height={72} alt="" />
          TRACEFORCE ENGINE
        </div>
        <div style={{ display: "flex", color: "#22d3ee", fontSize: 18 }}>BASE / ON-CHAIN INTELLIGENCE</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", fontSize: 90, lineHeight: 1.05, fontWeight: 700, letterSpacing: "-4px" }}>
        <div style={{ display: "flex" }}>Follow the money.</div>
        <div style={{ display: "flex", color: "#22d3ee" }}>Reconstruct the story.</div>
      </div>
      <div style={{ display: "flex", fontSize: 23, color: "#9bb0c0", borderTop: "1px solid #1d3344", paddingTop: 28 }}>Funding trails · Wallet connections · Accumulation · Selling evidence</div>
    </div>,
    size,
  );
}
