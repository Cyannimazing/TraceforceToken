import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness only: no credentials, internal hosts, or database connectivity are disclosed. */
export function GET() {
  return NextResponse.json({ status: "ok", service: "traceforce-engine", version: "0.1.0" });
}
