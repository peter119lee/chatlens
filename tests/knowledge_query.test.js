"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { parse, emptyQuery, tokenize, tightenOperators, SYNTAX_ROWS, FIELDS } = require("../src/knowledge_query");

// --- free text -------------------------------------------------------------

test("bare words become free text", () => {
  const result = parse("1girl solo masterpiece");

  assert.deepEqual(result.freeText, ["1girl", "solo", "masterpiece"]);
  assert.deepEqual(result.tags, []);
});

test("an empty query yields an empty state", () => {
  const result = parse("");

  assert.deepEqual(result.freeText, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.parts, []);
});

test("null and whitespace are handled like an empty query", () => {
  assert.deepEqual(parse(null).freeText, []);
  assert.deepEqual(parse("   ").freeText, []);
});

// --- list fields -----------------------------------------------------------

test("key:value fills the matching list", () => {
  const result = parse("tag:1girl model:anima lora:darklight");

  assert.deepEqual(result.tags, ["1girl"]);
  assert.deepEqual(result.checkpoints, ["anima"]);
  assert.deepEqual(result.loras, ["darklight"]);
});

test("a leading dash excludes", () => {
  const result = parse("tag:1girl -tag:nsfw -model:sdxl");

  assert.deepEqual(result.tags, ["1girl"]);
  assert.deepEqual(result.excludeTags, ["nsfw"]);
  assert.deepEqual(result.excludeCheckpoints, ["sdxl"]);
});

test("repeats of the same value are collapsed", () => {
  assert.deepEqual(parse("tag:1girl tag:1girl").tags, ["1girl"]);
});

test("accepts = as well as : ", () => {
  assert.deepEqual(parse("tag=1girl").tags, ["1girl"]);
});

test("chinese aliases work", () => {
  assert.deepEqual(parse("标签:1girl").tags, ["1girl"]);
  assert.deepEqual(parse("模型:anima").checkpoints, ["anima"]);
  assert.deepEqual(parse("人:Caesar").senders, ["Caesar"]);
});

test("sender is its own field, so a name never leaks into free text", () => {
  const result = parse("sender:Caesar. 1girl");

  assert.deepEqual(result.senders, ["Caesar."]);
  assert.deepEqual(result.freeText, ["1girl"]);
});

// --- quoting ---------------------------------------------------------------

test("quoted values keep their spaces", () => {
  assert.deepEqual(parse('prompt:"long hair"').prompts, ["long hair"]);
});

test("a quoted value mid-token stays with its key", () => {
  const result = parse('tag:"looking at viewer" solo');

  assert.deepEqual(result.tags, ["looking at viewer"]);
  assert.deepEqual(result.freeText, ["solo"]);
});

test("tokenizer keeps quoted runs intact", () => {
  assert.deepEqual(tokenize('a "b c" d:"e f"'), ["a", '"b c"', 'd:"e f"']);
});

// --- numbers ---------------------------------------------------------------

test("numeric comparisons set the right bound", () => {
  assert.equal(parse("steps>=30").stepsMin, 30);
  assert.equal(parse("steps<=20").stepsMax, 20);
  assert.equal(parse("cfg>4").cfgMin, 4);
  assert.equal(parse("cfg<8").cfgMax, 8);
});

test("bare equality pins both bounds", () => {
  const result = parse("steps:30");

  assert.equal(result.stepsMin, 30);
  assert.equal(result.stepsMax, 30);
});

test("ranges accept either order", () => {
  const result = parse("steps:40..20");

  assert.equal(result.stepsMin, 20);
  assert.equal(result.stepsMax, 40);
});

test("spaces around an operator are tolerated", () => {
  assert.equal(tightenOperators("steps >= 30"), "steps>=30");
  assert.equal(parse("steps >= 30").stepsMin, 30);
});

test("a non-numeric value warns instead of throwing", () => {
  const result = parse("steps:many");

  assert.equal(result.stepsMin, null);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].reason, /数字/u);
});

test("decimals work for cfg", () => {
  assert.equal(parse("cfg:5.5").cfgMin, 5.5);
});

// --- dates -----------------------------------------------------------------

test("a single date pins one day", () => {
  const result = parse("date:2026-07-15");

  assert.equal(result.dateFrom, "2026-07-15");
  assert.equal(result.dateTo, "2026-07-15");
});

test("a date range is inclusive on both ends", () => {
  const result = parse("date:2026-07-01..2026-07-31");

  assert.equal(result.dateFrom, "2026-07-01");
  assert.equal(result.dateTo, "2026-07-31");
});

test("a malformed date warns", () => {
  const result = parse("date:july");

  assert.equal(result.dateFrom, null);
  assert.equal(result.warnings.length, 1);
});

// --- enums and flags -------------------------------------------------------

test("aspect accepts only known values", () => {
  assert.equal(parse("aspect:portrait").aspect, "portrait");
  assert.equal(parse("aspect:sideways").aspect, "");
  assert.equal(parse("aspect:sideways").warnings.length, 1);
});

test("has and no are one tri-state", () => {
  assert.equal(parse("has:answer").flags.answer, true);
  assert.equal(parse("no:answer").flags.answer, false);
  assert.equal(parse("no:file").flags.file, false);
});

test("an unknown flag value warns", () => {
  const result = parse("has:unicorn");

  assert.deepEqual(result.flags, {});
  assert.equal(result.warnings.length, 1);
});

// --- resilience ------------------------------------------------------------

test("an unknown key degrades to free text rather than erroring", () => {
  // Typing must never be blocked by a key the parser does not know, but the
  // fallback IS warned about: searching for the literal "colour:red" finds
  // nothing, which would otherwise look like a broken filter.
  const result = parse("colour:red 1girl");

  assert.ok(result.freeText.includes("colour:red"));
  assert.ok(result.freeText.includes("1girl"));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].reason, /普通文字/u);
});

test("a key with no value warns and is otherwise ignored", () => {
  const result = parse("tag:");

  assert.deepEqual(result.tags, []);
  assert.equal(result.warnings.length, 1);
});

test("excluding a field that cannot be excluded warns", () => {
  const result = parse("-steps:30");

  assert.equal(result.stepsMin, null);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].reason, /不支持排除/u);
});

test("a negative-looking free word is not mistaken for exclusion", () => {
  // Real lora names contain things like "style-000014".
  assert.deepEqual(parse("style-000014").freeText, ["style-000014"]);
});

test("query length and term count are bounded", () => {
  const long = `${"tag:x ".repeat(200)}`;
  const result = parse(long);

  assert.ok(result.tags.length <= 24);
});

// --- combining -------------------------------------------------------------

test("filters of different kinds stack", () => {
  const result = parse('sender:Caesar model:anima -tag:nsfw steps>=25 aspect:portrait has:answer 1girl');

  assert.deepEqual(result.senders, ["Caesar"]);
  assert.deepEqual(result.checkpoints, ["anima"]);
  assert.deepEqual(result.excludeTags, ["nsfw"]);
  assert.equal(result.stepsMin, 25);
  assert.equal(result.aspect, "portrait");
  assert.equal(result.flags.answer, true);
  assert.deepEqual(result.freeText, ["1girl"]);
});

// --- preview parts ---------------------------------------------------------

test("produces display parts so the UI can show what it understood", () => {
  const result = parse("tag:1girl -tag:nsfw steps>=30 solo");
  const kinds = result.parts.map((part) => part.kind);

  assert.ok(kinds.includes("include"));
  assert.ok(kinds.includes("exclude"));
  assert.ok(kinds.includes("number"));
  assert.ok(kinds.includes("free"));
});

// --- schema integrity ------------------------------------------------------

test("the empty state covers every declared field", () => {
  // Guards the failure mode where a field is parsed but never initialised, so
  // it is silently dropped downstream.
  const state = emptyQuery();
  for (const field of FIELDS) {
    if (field.kind === "list") {
      assert.ok(Array.isArray(state[field.target]), `${field.key} list missing`);
      const excludeKey = `exclude${field.target[0].toUpperCase()}${field.target.slice(1)}`;
      assert.ok(Array.isArray(state[excludeKey]), `${field.key} exclude list missing`);
    } else if (field.kind === "number") {
      assert.ok(`${field.target}Min` in state, `${field.key} min missing`);
      assert.ok(`${field.target}Max` in state, `${field.key} max missing`);
    }
  }
});

test("every documented syntax row actually parses", () => {
  // Keeps the in-app help honest: a row that no longer works is a failing test.
  for (const row of SYNTAX_ROWS) {
    const result = parse(row.syntax);
    const understood = result.parts.length > 0 || result.freeText.length > 0;
    assert.ok(understood, `documented syntax produced nothing: ${row.syntax}`);
    assert.deepEqual(result.warnings, [], `documented syntax warned: ${row.syntax}`);
  }
});
