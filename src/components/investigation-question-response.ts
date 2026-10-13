import { z } from "@/lib/validation";
import { questionAnswerSchema as answerSchema, type InvestigationAnswer } from "@/domain/investigations/questions";

const text = (maximum: number) => z.string().min(1).max(maximum).refine((value) => Boolean(value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
export type { InvestigationAnswer } from "@/domain/investigations/questions";

export class InvestigationQuestionError extends Error {
  constructor(message = "The answer could not be validated. Please try again.") { super(message); this.name = "InvestigationQuestionError"; }
}

export async function readInvestigationAnswer(response: Response, evidenceIds: ReadonlySet<string>, signal: AbortSignal): Promise<InvestigationAnswer> {
  const reader = response.body?.getReader();
  if (!reader) throw new InvestigationQuestionError();
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65536)) { void reader.cancel().catch(() => undefined); reader.releaseLock(); throw new InvestigationQuestionError(); }
  const decoder = new TextDecoder("utf-8", { fatal: true }); let size = 0, body = "";
  try {
    for (;;) {
      signal.throwIfAborted(); let cancel: (() => void) | undefined;
      const chunk = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true }); })]).finally(() => { if (cancel) signal.removeEventListener("abort", cancel); });
      if (chunk.done) break;
      size += chunk.value.byteLength; if (size > 65536) throw new InvestigationQuestionError();
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    let value: unknown; try { value = JSON.parse(body); } catch { throw new InvestigationQuestionError(); }
    if (!response.ok) {
      const error = z.object({ error: text(240) }).strict().safeParse(value);
      throw new InvestigationQuestionError(error.success ? error.data.error : "Questions are temporarily unavailable. Please try again.");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new InvestigationQuestionError();
    const parsed = answerSchema.safeParse(value);
    if (!parsed.success || new Set(parsed.data.evidenceIds).size !== parsed.data.evidenceIds.length || parsed.data.evidenceIds.some((id) => !evidenceIds.has(id))) throw new InvestigationQuestionError();
    return parsed.data;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof InvestigationQuestionError) throw error;
    throw new InvestigationQuestionError();
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
