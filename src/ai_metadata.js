"use strict";

// AI generation metadata parsing for the formats that actually show up in the
// QQ image cache: A1111/Forge "parameters" strings, ComfyUI API graphs, and
// NovelAI comment JSON. Ported from the sd-image-sorter Python parser, trimmed
// to the container/generator combinations observed in nt_data\Pic (all PNG).
//
// Bump PARSER_VERSION whenever extraction behaviour changes: build_knowledge_base
// re-parses any row stored by an older version.

const { readImageTextChunks } = require("./image_text_chunks");

const PARSER_VERSION = 2;

const MAX_PROMPT_CHARS = 20000;
const MAX_RAW_CHARS = 60000;
const MAX_GRAPH_NODES = 4000;
const MAX_LINK_DEPTH = 16;

const asText = (value, limit = MAX_PROMPT_CHARS) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

// ComfyUI serializes graphs with Python's json.dumps, which emits bare NaN /
// Infinity for float sentinels (e.g. `"changed": [NaN]`). Those are invalid
// JSON, so JSON.parse rejects the whole graph where Python's json.loads accepts
// it. Replace the bare tokens with null when a first parse fails, taking care
// not to touch the same words inside string literals.
const JSON_SENTINEL_PATTERN = /(:\s*|\[\s*|,\s*)(-?\b(?:NaN|Infinity)\b)/gu;

const relaxPythonJson = (text) => {
  let inString = false;
  let escaped = false;
  const chars = [...text];
  const masked = chars.map((char) => {
    if (escaped) {
      escaped = false;
      return inString ? " " : char;
    }
    if (char === "\\" && inString) {
      escaped = true;
      return " ";
    }
    if (char === '"') {
      inString = !inString;
      return char;
    }
    return inString ? " " : char;
  }).join("");

  let result = "";
  let cursor = 0;
  for (const match of masked.matchAll(JSON_SENTINEL_PATTERN)) {
    const start = match.index + match[1].length;
    result += text.slice(cursor, start) + "null";
    cursor = start + match[2].length;
  }
  return result + text.slice(cursor);
};

const parseJsonOrNull = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(relaxPythonJson(value));
    } catch {
      return null;
    }
  }
};

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// --- A1111 / Forge / reForge ----------------------------------------------

const A1111_KEYS = new Map([
  ["steps", "steps"],
  ["sampler", "sampler"],
  ["schedule type", "scheduler"],
  ["cfg scale", "cfgScale"],
  ["seed", "seed"],
  ["size", "size"],
  ["model hash", "modelHash"],
  ["model", "model"],
  ["denoising strength", "denoisingStrength"],
  ["clip skip", "clipSkip"],
  ["version", "version"],
  ["lora hashes", "loraHashes"],
  ["hires upscaler", "hiresUpscaler"],
  ["hires steps", "hiresSteps"],
  ["vae", "vae"],
  ["module 1", "vae"],
]);

const PARAMS_LINE_PATTERN = /(?:^|,\s*)(?:Steps|Sampler|CFG scale|Seed|Size|Model hash|Schedule type):\s/u;

// Split on commas that are not inside double quotes: `Lora hashes: "a: h1, b: h2"`
// is a single field whose value legitimately contains commas.
const splitParamFields = (line) => {
  const fields = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(line.slice(start, index));
      start = index + 1;
    }
  }
  fields.push(line.slice(start));
  return fields.map((field) => field.trim()).filter((field) => field.length > 0);
};

const coerceParamValue = (key, raw) => {
  const value = raw.replace(/^"|"$/gu, "");
  if (key === "steps" || key === "clipSkip" || key === "hiresSteps") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (key === "cfgScale" || key === "denoisingStrength") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return value;
};

const parseParamsLine = (line) => {
  const params = {};
  const extra = {};
  for (const field of splitParamFields(line)) {
    const separator = field.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const rawKey = field.slice(0, separator).trim();
    const rawValue = field.slice(separator + 1).trim();
    const mapped = A1111_KEYS.get(rawKey.toLowerCase());
    if (mapped === undefined) {
      extra[rawKey] = rawValue;
    } else {
      const value = coerceParamValue(mapped, rawValue);
      if (value !== null && value !== "") {
        params[mapped] = value;
      }
    }
  }
  return { params, extra };
};

const lorasFromHashField = (loraHashes) =>
  asText(loraHashes)
    .replace(/^"|"$/gu, "")
    .split(",")
    .map((entry) => entry.split(":")[0].trim())
    .filter((name) => name.length > 0);

const lorasFromPrompt = (prompt) =>
  [...String(prompt).matchAll(/<lora:([^:>]+)(?::([\d.]+))?[^>]*>/giu)].map((match) => ({
    name: match[1].trim(),
    weight: match[2] === undefined ? null : Number.parseFloat(match[2]),
  }));

const detectWebuiFlavor = (version) => {
  const text = String(version ?? "");
  if (/reforge/iu.test(text)) {
    return "reforge";
  }
  return /^f\d/u.test(text) ? "forge" : "webui";
};

// The same lora legitimately appears in both an inline `<lora:name:weight>` tag
// and the trailing `Lora hashes` field, so every parser dedupes by name before
// returning. First occurrence wins, which keeps the inline weight.
// Loader nodes keep an empty slot rather than removing it, writing a literal
// placeholder in the name field. Those are "no lora here", not a lora called
// None -- and they are frequent enough to top an unfiltered ranking.
const LORA_PLACEHOLDERS = new Set(["none", "null", "undefined", "", "无", "不使用"]);

const dedupeLoras = (loras) => {
  const byName = new Map();
  for (const lora of loras) {
    const name = asText(lora.name, 300);
    if (name.length === 0 || LORA_PLACEHOLDERS.has(name.toLowerCase()) || byName.has(name)) {
      continue;
    }
    byName.set(name, { name, weight: lora.weight ?? null });
  }
  return [...byName.values()];
};

const parseA1111 = (parameters) => {
  const lines = String(parameters).split(/\r?\n/u);
  const lastLine = lines.at(-1) ?? "";
  const hasParamsLine = PARAMS_LINE_PATTERN.test(lastLine);
  const body = (hasParamsLine ? lines.slice(0, -1) : lines).join("\n");
  const { params, extra } = hasParamsLine ? parseParamsLine(lastLine) : { params: {}, extra: {} };

  const negativeIndex = body.search(/^Negative prompt:/mu);
  const prompt = negativeIndex === -1 ? body : body.slice(0, negativeIndex);
  const negativePrompt = negativeIndex === -1
    ? ""
    : body.slice(negativeIndex).replace(/^Negative prompt:\s*/u, "");

  const loras = dedupeLoras([
    ...lorasFromPrompt(prompt),
    ...lorasFromHashField(params.loraHashes).map((name) => ({ name, weight: null })),
  ]);

  return {
    generator: detectWebuiFlavor(params.version),
    prompt: asText(prompt),
    negativePrompt: asText(negativePrompt),
    checkpoint: asText(params.model, 300),
    modelHash: asText(params.modelHash, 64),
    loras,
    params,
    extra,
  };
};

// --- ComfyUI ---------------------------------------------------------------

const SAMPLER_PATTERN = /sampler/iu;
const CHECKPOINT_INPUTS = ["ckpt_name", "unet_name", "model_path"];

const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[1] === "number";

// Literal-text input names seen across the node packs in this cache:
//   text            CLIPTextEncode (stock)
//   value           PrimitiveStringMultiline
//   positive        WeiLinPromptUIWithoutLora
//   text_0          ShowText|pysssss
//   populated_text  ImpactWildcardProcessor
// `temp_str` is deliberately absent: WeiLin nodes stash their UI token editor
// state there as a JSON blob, which is not the prompt.
const TEXT_INPUT_KEYS = [
  "text",
  "value",
  "positive",
  "text_0",
  "prompt",
  "text_g",
  "text_l",
  "string",
  "populated_text",
  "wildcard_text",
];

const literalTextFrom = (inputs) => {
  for (const key of TEXT_INPUT_KEYS) {
    const value = inputs[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
};

// Walk upstream from a node link until a node exposing literal text is found.
// ComfyUI graphs chain conditioning through many pass-through nodes, so this
// follows link-valued inputs rather than assuming a fixed shape. Text-bearing
// input names are tried first at every hop, before descending further.
const resolveTextUpstream = (nodes, link, seen = new Set(), depth = 0) => {
  if (!isLink(link) || depth > MAX_LINK_DEPTH) {
    return "";
  }
  const nodeId = String(link[0]);
  if (seen.has(nodeId)) {
    return "";
  }
  const node = nodes[nodeId];
  if (!isPlainObject(node) || !isPlainObject(node.inputs)) {
    return "";
  }

  const literal = literalTextFrom(node.inputs);
  if (literal.length > 0) {
    return literal;
  }

  const nextSeen = new Set([...seen, nodeId]);
  // Prefer the conditioning-shaped inputs before arbitrary ones, so a sampler
  // chained off another sampler still lands on the prompt side of the graph.
  const ordered = [
    ...["text", "conditioning", "positive", "negative"].map((key) => node.inputs[key]),
    ...Object.values(node.inputs),
  ];
  for (const value of ordered) {
    const found = resolveTextUpstream(nodes, value, nextSeen, depth + 1);
    if (found.length > 0) {
      return found;
    }
  }
  return "";
};

const isSamplerCandidate = (node) =>
  isPlainObject(node)
  && isPlainObject(node.inputs)
  && isLink(node.inputs.positive)
  && isLink(node.inputs.negative);

// Efficiency node packs wire one sampler's `positive` to ANOTHER sampler's
// output, so the first candidate found can be a dead end for text traversal.
// Score candidates by whether their conditioning actually resolves to text,
// and only then fall back to the class-name heuristic.
const pickSamplerNode = (nodes) => {
  const candidates = Object.values(nodes).filter(isSamplerCandidate);
  if (candidates.length === 0) {
    return null;
  }
  const resolvable = candidates.filter(
    (node) => resolveTextUpstream(nodes, node.inputs.positive).length > 0,
  );
  const pool = resolvable.length > 0 ? resolvable : candidates;
  return pool.find((node) => SAMPLER_PATTERN.test(String(node.class_type ?? ""))) ?? pool[0];
};

// Some custom loader packs (WeiLin*, several LoraStack forks) store their whole
// slot list as a JSON *string* inside one input rather than as node inputs, so
// the names are invisible to a plain input scan.
const LORA_NAME_KEYS = ["lora_name", "lora", "name", "loraName"];
const LORA_WEIGHT_KEYS = ["strength_model", "lora_weight", "strength", "weight"];

const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const firstKeyValue = (entry, keys) => {
  for (const key of keys) {
    if (entry[key] !== undefined) {
      return entry[key];
    }
  }
  return undefined;
};

const lorasFromEmbeddedJson = (value) => {
  if (typeof value !== "string" || !value.includes("[") || value.length > MAX_RAW_CHARS) {
    return [];
  }
  const parsed = parseJsonOrNull(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((entry) => isPlainObject(entry) && entry.on !== false && entry.enabled !== false)
    .map((entry) => ({
      name: firstKeyValue(entry, LORA_NAME_KEYS),
      weight: numberOrNull(firstKeyValue(entry, LORA_WEIGHT_KEYS)),
    }))
    .filter((lora) => typeof lora.name === "string" && lora.name.trim().length > 0);
};

const collectComfyAssets = (nodes) => {
  const checkpoints = [];
  const loras = [];
  for (const node of Object.values(nodes)) {
    if (!isPlainObject(node) || !isPlainObject(node.inputs)) {
      continue;
    }
    for (const key of CHECKPOINT_INPUTS) {
      if (typeof node.inputs[key] === "string") {
        checkpoints.push(node.inputs[key]);
      }
    }
    if (typeof node.inputs.lora_name === "string") {
      loras.push({ name: node.inputs.lora_name, weight: numberOrNull(node.inputs.strength_model) });
    }
    for (const value of Object.values(node.inputs)) {
      // rgthree Power Lora Loader stores one object per slot: { on, lora, strength }.
      if (isPlainObject(value) && typeof value.lora === "string" && value.on !== false) {
        loras.push({ name: value.lora, weight: numberOrNull(value.strength) });
      }
      loras.push(...lorasFromEmbeddedJson(value));
    }
  }
  return { checkpoints, loras };
};

const comfyParamsFromSampler = (sampler, nodes) => {
  const inputs = isPlainObject(sampler?.inputs) ? sampler.inputs : {};
  const latent = Object.values(nodes).find((node) =>
    isPlainObject(node) && isPlainObject(node.inputs)
    && typeof node.inputs.width === "number" && typeof node.inputs.height === "number");

  const params = {
    steps: typeof inputs.steps === "number" ? inputs.steps : null,
    cfgScale: typeof inputs.cfg === "number" ? inputs.cfg : null,
    sampler: asText(inputs.sampler_name, 64),
    scheduler: asText(inputs.scheduler, 64),
    denoisingStrength: typeof inputs.denoise === "number" ? inputs.denoise : null,
    seed: String(inputs.seed ?? inputs.noise_seed ?? ""),
    size: latent === undefined ? "" : `${latent.inputs.width}x${latent.inputs.height}`,
  };
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== ""));
};

// The `workflow` chunk is the UI-side graph: nodes carry `widgets_values`
// arrays instead of named inputs, and edges live in a separate `links` table.
// It is only consulted when the API-shaped `prompt` chunk is missing or
// unparseable, so a damaged prompt chunk still yields model/LoRA names.
const WIDGET_NAME_PATTERN = /\.(?:safetensors|ckpt|pt|sft|gguf)$/iu;

const assetsFromWorkflowGraph = (workflow) => {
  if (!isPlainObject(workflow) || !Array.isArray(workflow.nodes)) {
    return null;
  }
  const checkpoints = [];
  const loras = [];
  const texts = [];

  for (const node of workflow.nodes.slice(0, MAX_GRAPH_NODES)) {
    if (!isPlainObject(node)) {
      continue;
    }
    const type = String(node.type ?? "");
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    for (const widget of widgets) {
      if (typeof widget === "string" && WIDGET_NAME_PATTERN.test(widget)) {
        if (/lora/iu.test(type)) {
          loras.push({ name: widget, weight: null });
        } else {
          checkpoints.push(widget);
        }
        continue;
      }
      loras.push(...lorasFromEmbeddedJson(widget));
      // A long free-text widget on an encode node is the prompt itself.
      if (typeof widget === "string" && widget.length > 8 && /encode|text|prompt/iu.test(type)) {
        texts.push(widget);
      }
    }
  }
  return { checkpoints, loras, texts };
};

// `ComfyUI_00042_.safetensors` is an *output* filename that img2img workflows
// feed back in as a loader input; it is never the real checkpoint.
const OUTPUT_NAME_PATTERN = /^ComfyUI[_\d]*\.?|^\d+_?\./iu;

const pickCheckpoint = (checkpoints) => {
  const named = checkpoints.filter((name) => typeof name === "string" && name.trim().length > 0);
  return named.find((name) => !OUTPUT_NAME_PATTERN.test(name)) ?? named[0] ?? "";
};

const parseComfyUi = (chunks) => {
  const graph = parseJsonOrNull(chunks.prompt);
  if (isPlainObject(graph) && Object.keys(graph).length <= MAX_GRAPH_NODES) {
    const sampler = pickSamplerNode(graph);
    const { checkpoints, loras } = collectComfyAssets(graph);
    return {
      generator: "comfyui",
      prompt: asText(sampler === null ? "" : resolveTextUpstream(graph, sampler.inputs.positive)),
      negativePrompt: asText(sampler === null ? "" : resolveTextUpstream(graph, sampler.inputs.negative)),
      checkpoint: asText(pickCheckpoint(checkpoints), 300),
      modelHash: "",
      loras: dedupeLoras(loras),
      params: sampler === null ? {} : comfyParamsFromSampler(sampler, graph),
      extra: {},
    };
  }

  const fallback = assetsFromWorkflowGraph(parseJsonOrNull(chunks.workflow));
  if (fallback === null) {
    return null;
  }
  return {
    generator: "comfyui",
    prompt: asText(fallback.texts[0]),
    negativePrompt: asText(fallback.texts[1]),
    checkpoint: asText(pickCheckpoint(fallback.checkpoints), 300),
    modelHash: "",
    loras: dedupeLoras(fallback.loras),
    params: {},
    extra: { source: "workflow-fallback" },
  };
};

// --- NovelAI ---------------------------------------------------------------

const NAI_PARAM_KEYS = new Map([
  ["steps", "steps"],
  ["sampler", "sampler"],
  ["scale", "cfgScale"],
  ["seed", "seed"],
  ["noise_schedule", "scheduler"],
  ["strength", "denoisingStrength"],
]);

const parseNovelAi = (chunks) => {
  const comment = parseJsonOrNull(chunks.Comment) ?? {};
  const prompt = asText(comment.prompt) || asText(chunks.Description);
  const negativePrompt = asText(comment.uc);

  const params = {};
  for (const [source, target] of NAI_PARAM_KEYS) {
    const value = comment[source];
    if (value !== undefined && value !== null && value !== "") {
      params[target] = typeof value === "number" ? value : String(value);
    }
  }
  if (typeof comment.width === "number" && typeof comment.height === "number") {
    params.size = `${comment.width}x${comment.height}`;
  }
  if (params.seed !== undefined) {
    params.seed = String(params.seed);
  }

  return {
    generator: "nai",
    prompt,
    negativePrompt,
    checkpoint: asText(chunks.Source, 300),
    modelHash: "",
    loras: [],
    params,
    extra: {},
  };
};

// --- facade ----------------------------------------------------------------

const EMPTY_RESULT = {
  generator: "unknown",
  prompt: "",
  negativePrompt: "",
  checkpoint: "",
  modelHash: "",
  loras: [],
  params: {},
  extra: {},
};

// Order matters. Images often carry chunks from more than one tool: a Forge
// render whose workflow came from ComfyUI keeps BOTH an authoritative
// `parameters` string and a stale `workflow` graph. The A1111 string is written
// by whichever tool actually produced the file, so it wins whenever it parses
// into a real prompt; the ComfyUI graph is only consulted when it does not.
const detectAndParse = (chunks) => {
  if (String(chunks.Software ?? "").includes("NovelAI") || chunks.Comment !== undefined) {
    const nai = parseNovelAi(chunks);
    if (nai.prompt.length > 0) {
      return nai;
    }
  }

  const parameters = chunks.parameters ?? chunks.UserComment ?? chunks.ImageDescription;
  if (typeof parameters === "string" && parameters.trim().length > 0) {
    const a1111 = parseA1111(parameters);
    if (a1111.prompt.length > 0 || Object.keys(a1111.params).length > 0) {
      return a1111;
    }
  }

  if (typeof chunks.prompt === "string" || typeof chunks.workflow === "string") {
    const comfy = parseComfyUi(chunks);
    if (comfy !== null && (comfy.prompt.length > 0 || comfy.loras.length > 0)) {
      return comfy;
    }
  }
  return null;
};

const rawChunksFor = (chunks) => {
  const kept = Object.entries(chunks)
    .map(([key, value]) => [key, String(value).slice(0, MAX_RAW_CHARS)]);
  return Object.fromEntries(kept);
};

// Parses one image file. Never throws; unreadable or metadata-free files come
// back with generator "unknown" so callers can record the miss rather than
// silently skipping the file.
const parseAiMetadata = (filePath, fileSize = 0) => {
  const container = readImageTextChunks(filePath);
  if (container === null) {
    return { ...EMPTY_RESULT, container: null, width: 0, height: 0, fileSize, rawChunks: {}, parserVersion: PARSER_VERSION };
  }

  const parsed = detectAndParse(container.chunks) ?? EMPTY_RESULT;
  // Several exporters echo the positive prompt into the negative slot when the
  // negative is empty; treating that as a real negative poisons search results.
  const negativePrompt = parsed.negativePrompt === parsed.prompt ? "" : parsed.negativePrompt;

  return {
    ...parsed,
    negativePrompt,
    loras: dedupeLoras(parsed.loras),
    container: container.container,
    width: container.width,
    height: container.height,
    fileSize,
    rawChunks: rawChunksFor(container.chunks),
    parserVersion: PARSER_VERSION,
  };
};

module.exports = {
  PARSER_VERSION,
  parseAiMetadata,
  // exported for tests
  parseA1111,
  parseComfyUi,
  parseNovelAi,
  detectAndParse,
  splitParamFields,
};
