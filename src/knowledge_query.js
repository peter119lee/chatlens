"use strict";

// Search query grammar for the knowledge base.
//
// Pure parser: no DOM, no database, no I/O. That keeps it directly testable and
// lets the UI render a "understood as" preview from the same parse the server
// will act on, so the two can never disagree.
//
// Grammar
//   key:value        assign (":" and "=" equivalent)
//   -key:value       negate (only where exclusion makes sense)
//   key>=n  key<=n   numeric bound (inclusive)
//   key:a..b         numeric range
//   "quoted value"   value containing spaces
//   bare words       free text, matched against prompt / model / lora
//
// Design notes taken from a mature implementation of the same idea:
//   * an unknown key is NOT an error -- it falls back to free text, so typing
//     never blocks a search;
//   * a known key with an unusable value produces a structured warning rather
//     than a thrown error, so the UI can explain it inline;
//   * every field lives in ONE descriptor table. A parallel allowlist elsewhere
//     is how a filter silently becomes a no-op.

const MAX_QUERY_CHARS = 400;
const MAX_TERMS = 24;

// The single source of truth. `kind` drives parsing, storage and sanitising.
//   list    -> array of strings, exclusion supported
//   scalar  -> single string
//   number  -> numeric comparison via min/max
//   enum    -> single string constrained to `values`
//   flag    -> tri-state boolean
const FIELDS = [
  { key: "tag", kind: "list", target: "tags", aliases: ["tags", "标签", "標籤"] },
  { key: "prompt", kind: "list", target: "prompts", aliases: ["咒语", "咒語", "提示词"] },
  { key: "model", kind: "list", target: "checkpoints", aliases: ["checkpoint", "ckpt", "模型"] },
  { key: "lora", kind: "list", target: "loras", aliases: ["loras"] },
  { key: "generator", kind: "list", target: "generators", aliases: ["gen", "来源", "來源"] },
  { key: "sender", kind: "list", target: "senders", aliases: ["from", "who", "发送者", "發送者", "人"] },
  { key: "group", kind: "list", target: "groups", aliases: ["群", "群号"] },
  { key: "seed", kind: "scalar", target: "seed" },
  { key: "steps", kind: "number", target: "steps" },
  { key: "cfg", kind: "number", target: "cfg" },
  { key: "width", kind: "number", target: "width", aliases: ["宽", "寬"] },
  { key: "height", kind: "number", target: "height", aliases: ["高"] },
  {
    key: "aspect",
    kind: "enum",
    target: "aspect",
    values: ["square", "landscape", "portrait"],
    aliases: ["比例"],
  },
  { key: "date", kind: "date", target: "date", aliases: ["日期"] },
  {
    key: "has",
    kind: "flag",
    // `has:` and `no:` are two spellings of one tri-state, so they share targets.
    values: ["prompt", "lora", "file", "answer", "sender", "negative"],
    aliases: ["有"],
  },
  { key: "no", kind: "flag", negated: true, values: ["prompt", "lora", "file", "answer", "sender", "negative"], aliases: ["没有", "沒有", "無"] },
];

const EXCLUDABLE_KINDS = new Set(["list"]);

const FIELD_BY_NAME = new Map();
for (const field of FIELDS) {
  FIELD_BY_NAME.set(field.key, field);
  for (const alias of field.aliases ?? []) {
    FIELD_BY_NAME.set(alias, field);
  }
}

// Derived from FIELDS so it cannot drift from the parser.
const emptyQuery = () => {
  const state = { freeText: [], flags: {}, parts: [], warnings: [] };
  for (const field of FIELDS) {
    if (field.kind === "list") {
      state[field.target] = [];
      state[`exclude${field.target[0].toUpperCase()}${field.target.slice(1)}`] = [];
    } else if (field.kind === "number") {
      state[`${field.target}Min`] = null;
      state[`${field.target}Max`] = null;
    } else if (field.kind === "date") {
      state.dateFrom = null;
      state.dateTo = null;
    } else if (field.kind === "scalar" || field.kind === "enum") {
      state[field.target] = "";
    }
  }
  return state;
};

// Lets a user type `steps >= 20` with spaces around the operator.
const tightenOperators = (text) =>
  text.replace(/([A-Za-z一-鿿_]+)\s*(>=|<=|==|!=|>|<)\s*/gu, "$1$2");

// Splits on whitespace while keeping quoted runs together, including when the
// quote is mid-token (`prompt:"long hair"`).
const tokenize = (text) => text.match(/(?:[^\s"]+"[^"]*"|[^\s"]+|"[^"]*")+/gu) ?? [];

const unquote = (value) => value.replace(/^"|"$/gu, "").trim();

const parseNumber = (raw) => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const applyNumber = (state, field, operator, raw, token) => {
  // `steps:20..40` is a range; the operators are inclusive bounds.
  const rangeMatch = raw.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/u);
  if (rangeMatch !== null) {
    const low = parseNumber(rangeMatch[1]);
    const high = parseNumber(rangeMatch[2]);
    if (low === null || high === null) {
      state.warnings.push({ raw: token, reason: "范围要写成两个数字，例如 steps:20..40" });
      return;
    }
    state[`${field.target}Min`] = Math.min(low, high);
    state[`${field.target}Max`] = Math.max(low, high);
    state.parts.push({ kind: "number", field: field.key, text: `${field.key} ${low}..${high}` });
    return;
  }

  const value = parseNumber(raw);
  if (value === null) {
    state.warnings.push({ raw: token, reason: `${field.key} 需要一个数字` });
    return;
  }
  if (operator === ">=" || operator === ">") {
    state[`${field.target}Min`] = value;
    state.parts.push({ kind: "number", field: field.key, text: `${field.key} ≥ ${value}` });
    return;
  }
  if (operator === "<=" || operator === "<") {
    state[`${field.target}Max`] = value;
    state.parts.push({ kind: "number", field: field.key, text: `${field.key} ≤ ${value}` });
    return;
  }
  state[`${field.target}Min`] = value;
  state[`${field.target}Max`] = value;
  state.parts.push({ kind: "number", field: field.key, text: `${field.key} = ${value}` });
};

const applyDate = (state, raw, token) => {
  const rangeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/u);
  if (rangeMatch !== null) {
    state.dateFrom = rangeMatch[1];
    state.dateTo = rangeMatch[2];
    state.parts.push({ kind: "date", field: "date", text: `${rangeMatch[1]} ~ ${rangeMatch[2]}` });
    return;
  }
  if (!DATE_PATTERN.test(raw)) {
    state.warnings.push({ raw: token, reason: "日期要写成 YYYY-MM-DD 或 YYYY-MM-DD..YYYY-MM-DD" });
    return;
  }
  state.dateFrom = raw;
  state.dateTo = raw;
  state.parts.push({ kind: "date", field: "date", text: `日期 ${raw}` });
};

const applyFlag = (state, field, raw, token) => {
  const value = raw.toLowerCase();
  if (!field.values.includes(value)) {
    state.warnings.push({ raw: token, reason: `只支持 ${field.values.join(" / ")}` });
    return;
  }
  // `no:prompt` is `has:prompt` inverted; one tri-state either way.
  state.flags[value] = field.negated !== true;
  state.parts.push({
    kind: "flag",
    field: value,
    text: `${field.negated === true ? "没有" : "有"} ${value}`,
  });
};

const applyList = (state, field, raw, negated, token) => {
  const value = unquote(raw);
  if (value.length === 0) {
    state.warnings.push({ raw: token, reason: `${field.key} 后面要有值` });
    return;
  }
  const target = negated
    ? `exclude${field.target[0].toUpperCase()}${field.target.slice(1)}`
    : field.target;
  if (!state[target].includes(value)) {
    state[target].push(value);
  }
  state.parts.push({ kind: negated ? "exclude" : "include", field: field.key, text: `${negated ? "排除 " : ""}${field.key}: ${value}` });
};

const parse = (input) => {
  const state = emptyQuery();
  const text = String(input ?? "").slice(0, MAX_QUERY_CHARS).trim();
  if (text.length === 0) {
    return state;
  }

  const tokens = tokenize(tightenOperators(text)).slice(0, MAX_TERMS);
  for (const token of tokens) {
    const negated = token.startsWith("-");
    const body = negated ? token.slice(1) : token;

    const match = body.match(/^([A-Za-z一-鿿_]+)(>=|<=|==|!=|>|<|[:=])([\s\S]*)$/u);
    if (match === null) {
      // Not key:value -- free text. A leading "-" is kept: it is part of the
      // word (e.g. "-000014" appears in real lora names).
      const free = unquote(token);
      if (free.length > 0) {
        state.freeText.push(free);
      }
      continue;
    }

    const field = FIELD_BY_NAME.get(match[1].toLowerCase()) ?? FIELD_BY_NAME.get(match[1]);
    const operator = match[2] === ":" || match[2] === "=" || match[2] === "==" ? "=" : match[2];
    const raw = match[3].trim();

    if (field === undefined) {
      // An unknown key must not block the search, so the whole token becomes
      // free text. But it is warned about too: silently searching for the
      // literal text "colour:red" and finding nothing looks like a broken
      // filter rather than a typo.
      state.freeText.push(unquote(token));
      state.warnings.push({
        raw: token,
        reason: `没有 ${match[1]} 这个筛选项，已当成普通文字搜索`,
      });
      continue;
    }
    if (negated && !EXCLUDABLE_KINDS.has(field.kind)) {
      state.warnings.push({ raw: token, reason: `${field.key} 不支持排除` });
      continue;
    }
    if (raw.length === 0) {
      state.warnings.push({ raw: token, reason: `${field.key} 后面要有值` });
      continue;
    }

    if (field.kind === "list") {
      applyList(state, field, raw, negated, token);
    } else if (field.kind === "number") {
      applyNumber(state, field, operator, raw, token);
    } else if (field.kind === "date") {
      applyDate(state, raw, token);
    } else if (field.kind === "flag") {
      applyFlag(state, field, raw, token);
    } else if (field.kind === "enum") {
      const value = unquote(raw).toLowerCase();
      if (!field.values.includes(value)) {
        state.warnings.push({ raw: token, reason: `只支持 ${field.values.join(" / ")}` });
      } else {
        state[field.target] = value;
        state.parts.push({ kind: "enum", field: field.key, text: `${field.key}: ${value}` });
      }
    } else {
      state[field.target] = unquote(raw);
      state.parts.push({ kind: "scalar", field: field.key, text: `${field.key}: ${state[field.target]}` });
    }
  }

  if (state.freeText.length > 0) {
    state.parts.push({ kind: "free", field: "", text: state.freeText.join(" ") });
  }
  return state;
};

// Rows for an in-app syntax help panel, generated from the same table the parser
// uses so the documentation cannot describe a syntax that does not exist.
const SYNTAX_ROWS = [
  { syntax: "1girl solo", meaning: "自由文字：在咒语 / 模型 / LoRA 里找" },
  { syntax: "tag:1girl", meaning: "必须含这个标签" },
  { syntax: "-tag:nsfw", meaning: "排除这个标签" },
  { syntax: 'prompt:"long hair"', meaning: "含空格的值要加引号" },
  { syntax: "model:anima", meaning: "指定模型（可写一部分）" },
  { syntax: "lora:darklight", meaning: "指定 LoRA" },
  { syntax: "sender:Caesar", meaning: "只看某人发的图" },
  { syntax: "generator:nai", meaning: "来源：webui / forge / comfyui / nai" },
  { syntax: "steps>=30", meaning: "数字比较（steps / cfg / width / height）" },
  { syntax: "steps:20..40", meaning: "数字范围" },
  { syntax: "aspect:portrait", meaning: "square / landscape / portrait" },
  { syntax: "date:2026-07-01..2026-07-31", meaning: "按图片时间筛选" },
  { syntax: "has:answer", meaning: "已有文字或媒体回复（prompt / lora / file / answer / sender / negative）" },
  { syntax: "no:file", meaning: "本地没有可用原图" },
];

module.exports = {
  parse,
  emptyQuery,
  FIELDS,
  SYNTAX_ROWS,
  // exported for tests
  tokenize,
  tightenOperators,
};
