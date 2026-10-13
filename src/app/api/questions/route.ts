import { questionRequestSchema } from "@/domain/investigations/questions";
import { HttpError, jsonError, readSmallJson } from "@/lib/http";
import { sameOrigin } from "@/lib/request-origin";
import { InvalidVisitorSessionError, visitorClientKey } from "@/lib/visitor-session";
import { createVisitorAdmissionRepository, VisitorRateLimitError } from "@/repositories/visitor-admission";
import { ScanCapacityError } from "@/services/scan-capacity";
import { ChatContextError } from "@/agents/chat-context";
import { prepareQuestionExecution } from "@/server/question-execution";
import { assertInvestigationQuestionScope, InvestigationQuestionError } from "@/agents/questions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) throw new HttpError(403, "A same-origin request is required.");
    const client = visitorClientKey(request, process.env.RATE_LIMIT_SECRET);
    await createVisitorAdmissionRepository().consumeRequest(client);
    const parsed = questionRequestSchema.safeParse(await readSmallJson(request, 48 * 1024));
    if (!parsed.success) throw new HttpError(400, "Supply a question and the current scan context.");
    assertInvestigationQuestionScope(parsed.data.question, parsed.data.history);
    const execute = prepareQuestionExecution();
    const answer = await execute(parsed.data.question, parsed.data.context, request.signal, parsed.data.history);
    return Response.json(answer, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InvalidVisitorSessionError) return jsonError(new HttpError(403, error.message));
    if (error instanceof VisitorRateLimitError) return Response.json({ error: error.message, code: "RATE_LIMITED", retryAfterSeconds: error.retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds), "cache-control": "private, no-store" } });
    if (error instanceof ChatContextError) return jsonError(new HttpError(410, "This scan's chat context is unavailable or expired. Run a fresh scan."));
    if (error instanceof InvestigationQuestionError) {
      if (error.code === "OUT_OF_SCOPE") return jsonError(new HttpError(400, "Ask about this scan's funding, wallet links, accumulation, sales, evidence, or coverage."));
      if (error.code === "EXPIRED_CONTEXT" || error.code === "INVALID_CONTEXT") return jsonError(new HttpError(410, "This scan's chat context is unavailable or expired. Run a fresh scan."));
      if (error.code === "TIMEOUT") return jsonError(new HttpError(504, "The answer took too long. Try a shorter question about this scan."));
      return jsonError(new HttpError(503, "The AI answer could not be verified. Try rephrasing your question about this scan."));
    }
    return jsonError(error instanceof ScanCapacityError ? new HttpError(429, error.message) : error);
  }
}
