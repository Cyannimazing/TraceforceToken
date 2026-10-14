import assert from "node:assert/strict";
import test from "node:test";
import { parseUniqueModelJson } from "../../src/agents/model-json";

test("model JSON rejects duplicate answer, caveat, evidence and brief fields instead of accepting the last value", () => {
  for (const content of [
    '{"answer":"first","answer":"last"}',
    '{"caveat":"important limit","caveat":""}',
    '{"evidenceIds":["E1"],"evidenceIds":[]}',
    '{"brief":{"text":"first"},"brief":{"text":"last"}}',
    '{"brief":{"text":"first","text":"last"}}',
    '{"evidenceIds":[],"answer":"valid","evidenceIds":[]}',
  ]) assert.throws(() => parseUniqueModelJson(content), SyntaxError, content);
});

test("escaped property names collide with their decoded spelling in the same object", () => {
  for (const content of [
    String.raw`{"evidenceIds":[],"\u0065videnceIds":["E1"]}`,
    String.raw`{"a\"b":1,"a\u0022b":2}`,
    String.raw`{"nested":{"\u0062rief":{},"brief":{}}}`,
  ]) assert.throws(() => parseUniqueModelJson(content), SyntaxError);
});

test("keys in separate objects and punctuation or escaped quotes inside string values remain valid", () => {
  const content = String.raw`{"brief":{"text":"A comma, braces {} and [brackets]; quote \"brief\": and backslash \\ are text."},"rows":[{"evidenceIds":[]},{"evidenceIds":["E1"]}],"other":{"brief":{}},"Answer":1,"answer":2}`;
  assert.deepEqual(parseUniqueModelJson(content), JSON.parse(content));
  assert.deepEqual(parseUniqueModelJson('[{"x":{"key":1}},{"x":{"key":2}}]'), [{ x: { key: 1 } }, { x: { key: 2 } }]);
  assert.equal(parseUniqueModelJson('"{\\\"answer\\\":1,\\\"answer\\\":2}"'), '{"answer":1,"answer":2}');
});

test("malformed model JSON fails with a fixed error and never exposes its content", () => {
  for (const content of ["", '{"private":', '{"private":"unterminated}', '[1,]', '{"x":1,}', String.raw`{"x":"bad\q"}`, '{"x":[]} ]']) {
    assert.throws(() => parseUniqueModelJson(content), (error: unknown) => error instanceof SyntaxError && error.message === "Invalid model JSON.");
  }
});

test("model JSON nesting and input size stay bounded", () => {
  const nested = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  assert.doesNotThrow(() => parseUniqueModelJson(nested(256)));
  assert.throws(() => parseUniqueModelJson(nested(257)), SyntaxError);
  assert.throws(() => parseUniqueModelJson(`"${"x".repeat(262_144)}"`), SyntaxError);
});
