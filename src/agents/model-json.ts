type Frame = { kind: "object"; keys: Set<string>; expectsKey: boolean } | { kind: "array" };

/** Model output must have one unambiguous value per property. JSON.parse alone
 * silently overwrites earlier duplicate keys before schema validation. */
export function parseUniqueModelJson(content: string): unknown {
  const invalid = (): never => { throw new SyntaxError("Invalid model JSON."); };
  // This cannot expand the transport's existing maximum response-byte budget.
  if (content.length > 262_144) invalid();
  const stack: Frame[] = [];
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === '"') {
      const start = index;
      for (index++; index < content.length && content[index] !== '"'; index++) {
        if (content[index] === "\\") index++;
      }
      if (index >= content.length) invalid();
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectsKey) {
        let key: unknown;
        try { key = JSON.parse(content.slice(start, index + 1)) as unknown; } catch { invalid(); }
        if (typeof key !== "string") return invalid();
        if (frame.keys.has(key)) invalid();
        frame.keys.add(key);
        frame.expectsKey = false;
      }
    } else if (character === "{" || character === "[") {
      if (stack.length >= 256) invalid();
      stack.push(character === "{" ? { kind: "object", keys: new Set(), expectsKey: true } : { kind: "array" });
    } else if (character === "}" || character === "]") {
      const frame = stack.pop();
      if (!frame || frame.kind !== (character === "}" ? "object" : "array")) invalid();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectsKey = true;
    }
  }
  if (stack.length) invalid();
  try { return JSON.parse(content) as unknown; } catch { return invalid(); }
}
