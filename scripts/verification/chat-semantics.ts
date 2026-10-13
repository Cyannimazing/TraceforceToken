/** Narrow operator checks, not a general classifier or runtime answer generator. */
const normalize = (text: string) => text.replaceAll("\u2019", "'");

export function lockUncertainty(text: string) {
  const prose = normalize(text);
  return {
    explicitUncertainty: /\b(?:unknown|unverified|unclear|undetermined|insufficient|not|cannot|can't|doesn't|does not|isn't)\b/i.test(prose),
    needsAdditionalEvidence: /\b(?:need(?:s|ed)?|require[sd]?)\b[^.!?]{0,90}\b(?:evidence|proof|verification)\b|\b(?:evidence|proof|verification)\b[^.!?]{0,90}\b(?:need(?:s|ed)?|require[sd]?)\b/i.test(prose),
  };
}

export function chatClaimsRemainQualified(answer: string, caveat: string) {
  const clauses = [answer, caveat].flatMap((part) => normalize(part).split(/[.!?;]\s+|\bbut\s+/));
  return {
    noUnsupportedLockAssertion: !clauses.some((part) => /^(?:(?:yes|no),?\s+)?(?:(?:the|these|this)\s+)?(?:contract\s+holdings?|tokens?|balance|it|they)(?:\s+(?:is|are|isn't|aren't)|'(?:s|re))\s+(?:not\s+)?(?:locked|unlocked)\b/i.test(part.trim())),
    noUnsupportedOwnershipClaim: !clauses.some((part) => /\b(?:prove[sd]?|establish(?:es|ed)?)\s+(?:common ownership|shared control)\b/i.test(part)
      && !/\b(?:not|no|cannot|can't|doesn't|unproven|unknown)\b/i.test(part)),
  };
}

export function contractSupplyShareMatches(text: string, expected: string | null) {
  for (const match of text.matchAll(/\bcontracts?\b[^.%]{0,100}\b([0-9]+(?:\.[0-9]+)?)%\s+of\s+(?:the\s+)?total\s+supply\b/gi)) {
    if (expected === null) return false;
    const precision = match[1].split(".")[1]?.length ?? 0;
    if (Number(match[1]) !== Number(Number(expected).toFixed(precision))) return false;
  }
  return true;
}
