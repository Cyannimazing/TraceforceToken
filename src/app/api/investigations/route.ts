import { HttpError, jsonError, readSmallJson } from "@/lib/http";
import { createVisitorAdmissionRepository, VisitorRateLimitError, VisitorScanActiveError } from "@/repositories/visitor-admission";
import { sameOrigin } from "@/lib/request-origin";
import { InvalidVisitorSessionError, visitorClientKey } from "@/lib/visitor-session";
import { scanParametersSchema } from "@/domain/investigations/scan";
import { prepareScanExecution } from "@/server/scan-execution";
import { ScanCapacityError } from "@/services/scan-capacity";
import { runVisitorScan } from "@/services/visitor-scan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) throw new HttpError(403, "A same-origin request is required.");
    const client = visitorClientKey(request, process.env.RATE_LIMIT_SECRET);
    const admission = createVisitorAdmissionRepository();
    await admission.consumeRequest(client);
    const parsed = scanParametersSchema.safeParse(await readSmallJson(request));
    if (!parsed.success) throw new HttpError(400, "Supply a Base token address and a valid full or recent-window scan scope.");
    const execute = prepareScanExecution();
    const lease = await admission.acquireScan(client);
    return await runVisitorScan((signal) => execute(parsed.data, signal), () => lease.release(), request.signal);
  } catch (error) {
    if (error instanceof InvalidVisitorSessionError) return jsonError(new HttpError(403, error.message));
    if (error instanceof VisitorRateLimitError || error instanceof VisitorScanActiveError) return Response.json({ error: error.message, code: error instanceof VisitorScanActiveError ? "SCAN_IN_PROGRESS" : "RATE_LIMITED", retryAfterSeconds: error.retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds), "cache-control": "private, no-store" } });
    return jsonError(error instanceof ScanCapacityError ? new HttpError(429, error.message) : error);
  }
}
