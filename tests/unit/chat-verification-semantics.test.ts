import assert from "node:assert/strict";
import test from "node:test";
import { chatClaimsRemainQualified, contractSupplyShareMatches, lockUncertainty } from "../../scripts/verification/chat-semantics";

test("operator accepts qualified lock uncertainty without requiring a repeated subject", () => {
  for (const prose of [
    "I cannot determine whether the tokens are locked.",
    "Its status can’t be inferred from account code.",
    "Additional verified evidence is required.",
    "Code does not prove the balance is locked or unlocked.",
  ]) {
    const uncertainty = lockUncertainty(prose);
    assert.ok(uncertainty.explicitUncertainty || uncertainty.needsAdditionalEvidence);
    assert.equal(chatClaimsRemainQualified(prose, "").noUnsupportedLockAssertion, true);
  }
});

test("operator rejects direct locked, unlocked and not-locked assertions", () => {
  for (const prose of ["The tokens are locked.", "The balance is unlocked.", "It is not locked.", "No, it isn't locked.", "Yes, it's locked.", "They’re unlocked."])
    assert.equal(chatClaimsRemainQualified(prose, "").noUnsupportedLockAssertion, false);
  assert.equal(chatClaimsRemainQualified("The answer is uncertain, but the tokens are locked.", "").noUnsupportedLockAssertion, false);
});

test("operator distinguishes ownership proof claims from explicit proof limitations", () => {
  for (const prose of ["This does not prove common ownership.", "Account code cannot establish shared control.", "The evidence doesn’t prove common ownership."])
    assert.equal(chatClaimsRemainQualified(prose, "").noUnsupportedOwnershipClaim, true);
  for (const prose of ["This proves common ownership.", "The evidence establishes shared control."])
    assert.equal(chatClaimsRemainQualified(prose, "").noUnsupportedOwnershipClaim, false);
});

test("operator checks contract supply percentages at the stated precision", () => {
  for (const percentage of ["84.64", "84.6", "85"])
    assert.equal(contractSupplyShareMatches(`The contract holds ${percentage}% of total supply.`, "84.64"), true);
  for (const percentage of ["84.65", "84.7", "85.00"])
    assert.equal(contractSupplyShareMatches(`The contract holds ${percentage}% of total supply.`, "84.64"), false);
  assert.equal(contractSupplyShareMatches("The contract holds 84.64% of total supply.", null), false);
  assert.equal(contractSupplyShareMatches("This table lists the contract separately.", null), true);
});
