"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { parseA1111, parseComfyUi, parseNovelAi, detectAndParse, splitParamFields, parseAiMetadata } = require("../src/ai_metadata");
const { readImageTextChunks } = require("../src/image_text_chunks");

// --- PNG builder (real container bytes, so the chunk reader is exercised) ----

const crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
};

const ihdr = (width, height) => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return pngChunk("IHDR", data);
};

const tEXt = (key, value) =>
  pngChunk("tEXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]));

const zTXt = (key, value) =>
  pngChunk("zTXt", Buffer.concat([
    Buffer.from(key, "latin1"), Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(value, "utf8")),
  ]));

const iTXt = (key, value, compressed) => {
  const payload = compressed ? zlib.deflateSync(Buffer.from(value, "utf8")) : Buffer.from(value, "utf8");
  return pngChunk("iTXt", Buffer.concat([
    Buffer.from(key, "latin1"),
    Buffer.from([0, compressed ? 1 : 0, 0]),
    Buffer.from([0]), // language
    Buffer.from([0]), // translated keyword
    payload,
  ]));
};

const writePng = (chunks, width = 64, height = 128) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimeta-")), "image.png");
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr(width, height),
    ...chunks,
    pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(32))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
  return file;
};

// --- container layer -------------------------------------------------------

test("reads tEXt, zTXt and both iTXt forms, and IHDR dimensions", () => {
  const file = writePng([
    tEXt("parameters", "plain text"),
    zTXt("zipped", "deflated text"),
    iTXt("intl", "utf8 text 中文", false),
    iTXt("intlz", "deflated utf8 中文", true),
  ], 896, 2048);

  const result = readImageTextChunks(file);

  assert.equal(result.container, "png");
  assert.equal(result.width, 896);
  assert.equal(result.height, 2048);
  assert.equal(result.chunks.parameters, "plain text");
  assert.equal(result.chunks.zipped, "deflated text");
  assert.equal(result.chunks.intl, "utf8 text 中文");
  assert.equal(result.chunks.intlz, "deflated utf8 中文");
});

test("returns null for a file that is neither PNG nor JPEG", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimeta-")), "not-image.bin");
  fs.writeFileSync(file, Buffer.from("this is not an image at all", "utf8"));

  assert.equal(readImageTextChunks(file), null);
});

test("missing file yields null instead of throwing", () => {
  assert.equal(readImageTextChunks(path.join(os.tmpdir(), "definitely-absent-12345.png")), null);
});

// --- A1111 -----------------------------------------------------------------

const A1111_TEXT = [
  "1girl, solo, <lora:styleA:0.8>, detailed",
  "Negative prompt: male, logo",
  'Steps: 30, Sampler: DPM++ 2M SDE, Schedule type: Karras, CFG scale: 5, Seed: 528929052, Size: 1024x1536, Model hash: 6bb9f65380, Model: DasiwaIllustriousXL, Lora hashes: "styleA: afac10eceab0, styleB: e91ce296493d", Version: f2.0.1v1.10.1',
].join("\n");

test("parses an A1111 parameters block into prompt, negative and params", () => {
  const result = parseA1111(A1111_TEXT);

  assert.equal(result.prompt, "1girl, solo, <lora:styleA:0.8>, detailed");
  assert.equal(result.negativePrompt, "male, logo");
  assert.equal(result.checkpoint, "DasiwaIllustriousXL");
  assert.equal(result.modelHash, "6bb9f65380");
  assert.equal(result.params.steps, 30);
  assert.equal(result.params.cfgScale, 5);
  assert.equal(result.params.sampler, "DPM++ 2M SDE");
  assert.equal(result.params.scheduler, "Karras");
  assert.equal(result.params.seed, "528929052");
});

test("keeps commas inside a quoted Lora hashes value as one field", () => {
  const fields = splitParamFields('Steps: 30, Lora hashes: "a: h1, b: h2", CFG scale: 5');

  assert.deepEqual(fields, ["Steps: 30", 'Lora hashes: "a: h1, b: h2"', "CFG scale: 5"]);
});

test("collects loras from both inline tags and the Lora hashes field", () => {
  const names = parseA1111(A1111_TEXT).loras.map((lora) => lora.name);

  assert.deepEqual(names, ["styleA", "styleB"]);
});

test("distinguishes forge from webui by the Version field", () => {
  assert.equal(parseA1111(A1111_TEXT).generator, "forge");
  assert.equal(parseA1111("a\nSteps: 5, Sampler: Euler, Version: v1.10.1").generator, "webui");
  assert.equal(parseA1111("a\nSteps: 5, Sampler: Euler, Version: f1.7.0-reForge").generator, "reforge");
});

test("treats a parameters block with no negative section as having none", () => {
  const result = parseA1111("just a prompt\nSteps: 20, Sampler: Euler, CFG scale: 7");

  assert.equal(result.prompt, "just a prompt");
  assert.equal(result.negativePrompt, "");
});

// --- ComfyUI ---------------------------------------------------------------

test("resolves prompts through a pass-through chain to the literal text node", () => {
  const graph = {
    3: { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["7", 0], steps: 25, cfg: 5, sampler_name: "euler_ancestral", scheduler: "normal", seed: 42 } },
    6: { class_type: "CLIPTextEncode", inputs: { text: ["35", 0], clip: ["4", 1] } },
    7: { class_type: "CLIPTextEncode", inputs: { text: ["36", 0], clip: ["4", 1] } },
    35: { class_type: "PrimitiveStringMultiline", inputs: { value: "masterpiece, 1girl" } },
    36: { class_type: "PrimitiveStringMultiline", inputs: { value: "worst quality" } },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "anima\\real.safetensors" } },
  };

  const result = parseComfyUi({ prompt: JSON.stringify(graph) });

  assert.equal(result.generator, "comfyui");
  assert.equal(result.prompt, "masterpiece, 1girl");
  assert.equal(result.negativePrompt, "worst quality");
  assert.equal(result.checkpoint, "anima\\real.safetensors");
  assert.equal(result.params.steps, 25);
  assert.equal(result.params.seed, "42");
});

test("accepts a graph containing bare NaN, which ComfyUI writes but JSON forbids", () => {
  const raw = '{"3":{"class_type":"KSampler","inputs":{"positive":["6",0],"negative":["6",0],"changed":[NaN],"steps":20}},'
    + '"6":{"class_type":"CLIPTextEncode","inputs":{"text":"a prompt"}}}';

  const result = parseComfyUi({ prompt: raw });

  assert.equal(result.prompt, "a prompt");
  assert.equal(result.params.steps, 20);
});

test("picks the sampler whose conditioning reaches text, not the first one found", () => {
  // KSampler (Efficient) chains its positive to another sampler's output, which
  // is a dead end for text traversal; the real prompt hangs off node 8.
  const graph = {
    433: { class_type: "KSampler (Efficient)", inputs: { positive: ["8", 1], negative: ["8", 2] } },
    8: { class_type: "KSampler Adv. (Efficient)", inputs: { positive: ["6", 0], negative: ["7", 0], steps: 28 } },
    6: { class_type: "WeiLinPromptUIWithoutLora", inputs: { positive: "cowboy shot, solo" } },
    7: { class_type: "WeiLinPromptUIWithoutLora", inputs: { positive: "low quality" } },
  };

  const result = parseComfyUi({ prompt: JSON.stringify(graph) });

  assert.equal(result.prompt, "cowboy shot, solo");
  assert.equal(result.negativePrompt, "low quality");
});

test("reads loras from an embedded json slot list and skips disabled ones", () => {
  const stack = JSON.stringify([
    { lora: "styleA.safetensors", strength: 0.8, on: true },
    { lora: "styleB.safetensors", strength: 1, on: false },
    { lora: "styleC.safetensors", strength: 0.5 },
  ]);
  const graph = {
    3: { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["6", 0] } },
    6: { class_type: "CLIPTextEncode", inputs: { text: "prompt" } },
    9: { class_type: "WeiLinPromptUIOnlyLoraStack", inputs: { lora_stack_json: stack } },
  };

  const names = parseComfyUi({ prompt: JSON.stringify(graph) }).loras.map((lora) => lora.name);

  assert.deepEqual(names, ["styleA.safetensors", "styleC.safetensors"]);
});

test("ignores an output filename fed back as a loader input", () => {
  const graph = {
    3: { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["6", 0] } },
    6: { class_type: "CLIPTextEncode", inputs: { text: "prompt" } },
    10: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "ComfyUI_00001_.safetensors" } },
    11: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "actual\\model.safetensors" } },
  };

  assert.equal(parseComfyUi({ prompt: JSON.stringify(graph) }).checkpoint, "actual\\model.safetensors");
});

test("falls back to the workflow graph when the prompt chunk is unusable", () => {
  const workflow = {
    nodes: [
      { type: "CheckpointLoaderSimple", widgets_values: ["real_model.safetensors"] },
      { type: "LoraLoader", widgets_values: ["some_style.safetensors", 0.7] },
      { type: "CLIPTextEncode", widgets_values: ["a recovered prompt string"] },
    ],
  };

  const result = parseComfyUi({ prompt: "{ this is not json", workflow: JSON.stringify(workflow) });

  assert.equal(result.checkpoint, "real_model.safetensors");
  assert.deepEqual(result.loras.map((lora) => lora.name), ["some_style.safetensors"]);
  assert.equal(result.prompt, "a recovered prompt string");
  assert.equal(result.extra.source, "workflow-fallback");
});

// --- NovelAI ---------------------------------------------------------------

test("parses NovelAI comment json", () => {
  const chunks = {
    Software: "NovelAI",
    Source: "NovelAI Diffusion V4.5 4BDE2A90",
    Description: "fallback description",
    Comment: JSON.stringify({
      prompt: "{{{artist:someone}}}, 1girl",
      uc: "nsfw, lowres",
      steps: 28,
      sampler: "k_euler_ancestral",
      scale: 4,
      seed: 3644428329,
      noise_schedule: "karras",
      width: 832,
      height: 1216,
    }),
  };

  const result = parseNovelAi(chunks);

  assert.equal(result.generator, "nai");
  assert.equal(result.prompt, "{{{artist:someone}}}, 1girl");
  assert.equal(result.negativePrompt, "nsfw, lowres");
  assert.equal(result.checkpoint, "NovelAI Diffusion V4.5 4BDE2A90");
  assert.equal(result.params.steps, 28);
  assert.equal(result.params.cfgScale, 4);
  assert.equal(result.params.seed, "3644428329");
  assert.equal(result.params.size, "832x1216");
});

test("falls back to the Description chunk when comment json lacks a prompt", () => {
  const chunks = { Software: "NovelAI", Description: "the visible prompt", Comment: JSON.stringify({ steps: 28 }) };

  assert.equal(parseNovelAi(chunks).prompt, "the visible prompt");
});

// --- detection precedence --------------------------------------------------

test("prefers an authoritative parameters string over a stale workflow graph", () => {
  // Forge writes `parameters`; a ComfyUI-exported `workflow` can linger in the
  // same file and must not win, or the prompt comes back as graph noise.
  const chunks = {
    parameters: "the real prompt\nSteps: 12, Sampler: er_sde, CFG scale: 1, Model: krea2Turbo",
    workflow: JSON.stringify({ nodes: [{ type: "CLIPTextEncode", widgets_values: ["match_latent_size"] }] }),
  };

  const result = detectAndParse(chunks);

  assert.equal(result.generator, "webui");
  assert.equal(result.prompt, "the real prompt");
});

test("uses the comfy graph when there is no parameters string", () => {
  const graph = {
    3: { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["6", 0] } },
    6: { class_type: "CLIPTextEncode", inputs: { text: "graph prompt" } },
  };

  assert.equal(detectAndParse({ prompt: JSON.stringify(graph) }).generator, "comfyui");
});

test("returns null when no known generator metadata is present", () => {
  assert.equal(detectAndParse({ Title: "just a title" }), null);
});

// --- facade ----------------------------------------------------------------

test("parses a real png end to end and reports the container", () => {
  const file = writePng([tEXt("parameters", A1111_TEXT)], 1024, 1536);

  const result = parseAiMetadata(file, 4242);

  assert.equal(result.container, "png");
  assert.equal(result.generator, "forge");
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1536);
  assert.equal(result.fileSize, 4242);
  assert.equal(result.prompt, "1girl, solo, <lora:styleA:0.8>, detailed");
  assert.ok(result.parserVersion >= 1);
});

test("metadata-free image reports unknown rather than failing", () => {
  const file = writePng([tEXt("Comment", "just a user comment")]);

  const result = parseAiMetadata(file);

  assert.equal(result.generator, "unknown");
  assert.equal(result.prompt, "");
  assert.deepEqual(result.loras, []);
});

test("drops a negative prompt that merely echoes the positive one", () => {
  const echoed = "same text both slots";
  const file = writePng([tEXt("parameters", `${echoed}\nNegative prompt: ${echoed}\nSteps: 10, Sampler: Euler`)]);

  assert.equal(parseAiMetadata(file).negativePrompt, "");
});

test("deduplicates loras by name across sources", () => {
  const text = "a <lora:dup:0.8> b\nSteps: 5, Sampler: Euler, Lora hashes: \"dup: abc123, other: def456\"";
  const file = writePng([tEXt("parameters", text)]);

  const names = parseAiMetadata(file).loras.map((lora) => lora.name);

  assert.deepEqual(names, ["dup", "other"]);
});

test("drops empty-slot placeholders instead of reporting a lora named None", () => {
  const graph = {
    3: { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["6", 0] } },
    6: { class_type: "CLIPTextEncode", inputs: { text: "prompt" } },
    12: { class_type: "Efficient Loader", inputs: { ckpt_name: "m.safetensors", lora_name: "None" } },
    13: { class_type: "LoraLoader", inputs: { lora_name: "real_style.safetensors", strength_model: 0.7 } },
  };

  const names = parseComfyUi({ prompt: JSON.stringify(graph) }).loras.map((lora) => lora.name);

  assert.deepEqual(names, ["real_style.safetensors"]);
});
