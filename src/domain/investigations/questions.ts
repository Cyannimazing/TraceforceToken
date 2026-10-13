import { z } from "@/lib/validation";

const prose = (maximum: number) => z.string().min(1).max(maximum).refine((value) => Boolean(value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
export const questionHistorySchema = z.array(z.object({ role: z.enum(["user", "assistant"]), content: prose(1000) }).strict()).max(6).refine(
  (messages) => messages.reduce((bytes, message) => bytes + new TextEncoder().encode(message.content).byteLength, 0) <= 8192,
  "Conversation context exceeds the supported byte limit.",
);
export type InvestigationChatMessage = z.infer<typeof questionHistorySchema>[number];
export const questionRequestSchema = z.object({ question: prose(1000), context: z.string().min(1).max(32768), history: questionHistorySchema.default([]) }).strict();
export const questionAnswerSchema = z.object({
  answer: prose(1000), caveat: z.union([z.literal(""), prose(300)]), needsFreshScan: z.boolean(),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/:\-]*$/).optional(),
  evidenceIds: z.array(z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/)).max(12),
}).strict();
export type InvestigationAnswer = z.infer<typeof questionAnswerSchema>;
