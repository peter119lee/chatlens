"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyAsk, looksLikePromptText, indexImageOwners, resolveTargetImage, pairPromptRequests } = require("../src/prompt_requests");

// --- kk-family detection ---------------------------------------------------

test("recognises the kk-family asks and their intents", () => {
  assert.deepEqual(classifyAsk("kkt", false), { intent: "prompt", rule: "kk:t" });
  assert.deepEqual(classifyAsk("kko", false), { intent: "original", rule: "kk:o" });
  assert.deepEqual(classifyAsk("kky", false), { intent: "original", rule: "kk:y" });
  assert.deepEqual(classifyAsk("kkp", false), { intent: "prompt", rule: "kk:p" });
});

test("tolerates punctuation and trailing chatter after a kk ask", () => {
  assert.equal(classifyAsk("kkt！", false).intent, "prompt");
  assert.equal(classifyAsk("KKT", false).intent, "prompt");
  assert.equal(classifyAsk("kko，有机会也去试试", false).intent, "original");
});

test("does not treat a question about the slang as a use of it", () => {
  // Real messages from the cache: people asking what kkt/kkp mean.
  assert.equal(classifyAsk("kkt是什么", false), null);
  assert.equal(classifyAsk("kkp是什么", false), null);
  assert.equal(classifyAsk("kkt什么意思", false), null);
});

test("requires a kk-family letter, not a bare kk prefix", () => {
  // Real messages: these are words that merely start with kk.
  assert.equal(classifyAsk("kk", false), null);
  assert.equal(classifyAsk("kk流", false), null);
  assert.equal(classifyAsk("kk模型和LoRA", false), null);
  assert.equal(classifyAsk("kk萝莉tag", false), null);
});

// --- whole-message Chinese asks --------------------------------------------

test("accepts a message that is entirely a request", () => {
  assert.equal(classifyAsk("原图", false).intent, "original");
  assert.equal(classifyAsk("原图呢", false).intent, "original");
  assert.equal(classifyAsk("看看原图", false).intent, "original");
  assert.equal(classifyAsk("看看tag", false).intent, "prompt");
  assert.equal(classifyAsk("看看提示词", false).intent, "prompt");
  assert.equal(classifyAsk("求tag", false).intent, "prompt");
  assert.equal(classifyAsk("康康", false).intent, "prompt");
});

test("rejects statements that merely contain the trigger words", () => {
  // Every one of these is a real message that naive substring matching grabbed.
  const statements = [
    "这是原图",
    "应该是原图",
    "发的就是原图",
    "ps是原图",
    "我没上传过原图吧",
    "原图，你要不读读看",
    "那张原图真的很喜欢",
    "网站上那个就是原图吗",
    "我拉原图看看吧",
    "用它原图加载工作流",
    "原图练满90%相似",
    "好看是还好，但是不是原图的效果",
    "截图比你发原图还清晰啊",
    "得改，因为原图的提示词我只保留了3个",
  ];
  for (const statement of statements) {
    assert.equal(classifyAsk(statement, false), null, `should reject: ${statement}`);
    assert.equal(classifyAsk(statement, true), null, `quote context must not rescue: ${statement}`);
  }
});

// --- contextual asks -------------------------------------------------------

test("accepts an imperative ask only when an image is quoted", () => {
  assert.equal(classifyAsk("提示词发来", false), null, "ambiguous without a quoted image");
  assert.equal(classifyAsk("提示词发来", true).intent, "prompt");
  assert.equal(classifyAsk("原图发来我cos一个", true).intent, "original");
  assert.equal(classifyAsk("那么工作流发来康康", true).intent, "prompt");
});

test("a quoted image does not make commentary into a request", () => {
  // The measured failure mode: replies quote an image while just remarking on it.
  assert.equal(classifyAsk("截图比你发原图还清晰啊", true), null);
  assert.equal(classifyAsk("之前处理nsfw的提示词给我爆回去了", true), null);
});

test("ignores long discussion even when it contains an ask phrase", () => {
  const long = "我觉得这个工作流发来康康也没什么用因为我的显卡跑不动这么大的模型还是算了吧真的";
  assert.equal(classifyAsk(long, true), null);
});

// --- answer detection ------------------------------------------------------

test("recognises pasted A1111 parameters as an answer", () => {
  const text = "1girl, solo\nNegative prompt: bad quality\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 5";
  assert.equal(looksLikePromptText(text), true);
});

test("recognises danbooru-style tag soup as an answer", () => {
  const text = "masterpiece, best quality, 1girl, solo, long hair, looking at viewer, blush, blue eyes, dress";
  assert.equal(looksLikePromptText(text), true);
});

test("rejects comma-heavy chinese prose", () => {
  // Real messages: comma-rich conversation that a segment-count heuristic accepted.
  const prose = [
    "她觉得，这种24小时视频，检查记录，干涉朋友关系，都是非常正常的事，但我就会很痛苦",
    "好就好在，她会给我做饭，会给我洗衣服，会出去兼职赚钱，然后还经常给我花钱买东西",
    "很久之前看过一个大佬在论坛说，vac，只要你自己写，不完全复制别人的代码，就很难被封",
    "就是说把衣服分别ps出来，然后叠在一个去衣的人物上，但是人物交互怎么做，局部重绘吗",
  ];
  for (const text of prose) {
    assert.equal(looksLikePromptText(text), false, `should reject prose: ${text.slice(0, 24)}`);
  }
});

test("rejects text too short to be a prompt", () => {
  assert.equal(looksLikePromptText("1girl, solo"), false);
  assert.equal(looksLikePromptText(""), false);
  assert.equal(looksLikePromptText(null), false);
});

test("requires more than one prompt-vocabulary hit", () => {
  // A single stray English tag inside a sentence is not a pasted prompt.
  assert.equal(looksLikePromptText("我觉得这个 1girl 的构图不太行, 要不要换一个, 你看看, 再调一下"), false);
});

// --- target resolution -----------------------------------------------------

const mediaMessage = (hash, overrides) => ({
  groupId: "1001",
  rowId: "100",
  sentAt: 1700000000,
  senderUin: "111",
  speaker: "Author",
  mediaRefs: [{ kind: "image", hash }],
  ...overrides,
});

test("indexes image owners by hash, keeping the first poster", () => {
  const owners = indexImageOwners([
    mediaMessage("a".repeat(32)),
    mediaMessage("a".repeat(32), { rowId: "200", speaker: "Reposter", senderUin: "222" }),
  ]);

  assert.equal(owners.size, 1);
  assert.equal(owners.get("a".repeat(32)).speaker, "Author");
});

test("resolves the target from the quoted hash", () => {
  const owners = indexImageOwners([mediaMessage("a".repeat(32))]);
  const ask = { groupId: "1001", sentAt: 1700000100 };
  const quoteLink = { quotedImageHashes: ["a".repeat(32)] };

  const target = resolveTargetImage(ask, quoteLink, owners);

  assert.equal(target.via, "quote");
  assert.equal(target.image.speaker, "Author");
});

test("reports a quoted hash that is outside this export as unresolved", () => {
  const owners = indexImageOwners([mediaMessage("a".repeat(32))]);
  const ask = { groupId: "1001", sentAt: 1700000100 };

  const target = resolveTargetImage(ask, { quotedImageHashes: ["b".repeat(32)] }, owners);

  assert.equal(target.via, "quote-unresolved");
  assert.equal(target.image.hash, "b".repeat(32));
  assert.equal(target.image.speaker, "", "an unresolved target must not claim an owner");
});

test("falls back to a single recent image only when the window is unambiguous", () => {
  const owners = indexImageOwners([
    mediaMessage("a".repeat(32), { sentAt: 1700000000, speaker: "Only" }),
  ]);

  const target = resolveTargetImage({ groupId: "1001", sentAt: 1700000060 }, undefined, owners);

  assert.equal(target.via, "recent-unambiguous");
  assert.equal(target.confidence, "low");
  assert.equal(target.image.speaker, "Only");
});

test("refuses to guess when several images compete for the same ask", () => {
  // Measured on real groups: picking the latest of many agrees with the
  // answering author only 38% of the time, so no guess is offered at all.
  const owners = indexImageOwners([
    mediaMessage("a".repeat(32), { sentAt: 1700000000, speaker: "First" }),
    mediaMessage("b".repeat(32), { rowId: "150", sentAt: 1700000030, speaker: "Second" }),
  ]);

  assert.equal(resolveTargetImage({ groupId: "1001", sentAt: 1700000060 }, undefined, owners), null);
});

test("refuses to guess from an image posted long before the ask", () => {
  const owners = indexImageOwners([mediaMessage("a".repeat(32), { sentAt: 1700000000 })]);

  assert.equal(resolveTargetImage({ groupId: "1001", sentAt: 1700000000 + 600 }, undefined, owners), null);
});

test("does not borrow an image from another group", () => {
  const owners = indexImageOwners([mediaMessage("a".repeat(32), { groupId: "2002" })]);

  assert.equal(resolveTargetImage({ groupId: "1001", sentAt: 1700000010 }, undefined, owners), null);
});

// --- end-to-end pairing ----------------------------------------------------

const PROMPT_ANSWER = "masterpiece, best quality, 1girl, solo, long hair, blue eyes, looking at viewer";

test("pairs image, ask and the author's answer", () => {
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", groupName: "G", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", groupName: "G", rowId: "300", sentAt: 1700000200, senderUin: "111", speaker: "Author", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: ["a".repeat(32)] }],
  });

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].intent, "prompt");
  assert.equal(pairs[0].imageHash, "a".repeat(32));
  assert.equal(pairs[0].imageOwner, "Author");
  assert.equal(pairs[0].asker, "Asker");
  assert.equal(pairs[0].answerBy, "Author");
  assert.equal(pairs[0].answerText, PROMPT_ANSWER);
  assert.equal(pairs[0].answerKind, "text");
  assert.deepEqual(pairs[0].answerMedia, []);
  assert.equal(pairs[0].targetVia, "quote");
  assert.equal(pairs[0].confidence, "high");
});

test("pairs an original-image request with a following image or file reply", () => {
  const targetHash = "a".repeat(32);
  const replyHash = "b".repeat(32);
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kko" },
      { groupId: "1001", rowId: "250", sentAt: 1700000110, senderUin: "333", speaker: "Other", text: PROMPT_ANSWER },
    ],
    mediaMessages: [
      mediaMessage(targetHash, { sentAt: 1700000000 }),
      mediaMessage(replyHash, {
        rowId: "300",
        sentAt: 1700000120,
        senderUin: "333",
        speaker: "Other",
        mediaRefs: [
          { kind: "image", hash: replyHash, fileName: `${replyHash}.png` },
          { kind: "file", hash: null, fileName: "original.zip" },
        ],
      }),
    ],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: [targetHash] }],
  });

  assert.equal(pairs[0].intent, "original");
  assert.equal(pairs[0].answerKind, "media");
  assert.equal(pairs[0].answerText, "", "prompt-shaped text is not an answer to kko");
  assert.equal(pairs[0].answerBy, "Other");
  assert.deepEqual(pairs[0].answerMedia, [
    { kind: "image", hash: replyHash, fileName: `${replyHash}.png` },
    { kind: "file", hash: null, fileName: "original.zip" },
  ]);
});

test("a prompt request still waits for text when an image is posted first", () => {
  const targetHash = "a".repeat(32);
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000140, senderUin: "111", speaker: "Author", text: PROMPT_ANSWER },
    ],
    mediaMessages: [
      mediaMessage(targetHash, { sentAt: 1700000000 }),
      mediaMessage("b".repeat(32), { rowId: "250", sentAt: 1700000120, senderUin: "111", speaker: "Author" }),
    ],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: [targetHash] }],
  });

  assert.equal(pairs[0].answerKind, "text");
  assert.equal(pairs[0].answerText, PROMPT_ANSWER);
  assert.deepEqual(pairs[0].answerMedia, []);
});

test("an original-image reply author does not rewrite the requested target", () => {
  const targetHash = "a".repeat(32);
  const replierEarlierHash = "b".repeat(32);
  const replyHash = "c".repeat(32);
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kko" },
    ],
    mediaMessages: [
      mediaMessage(replierEarlierHash, { rowId: "50", sentAt: 1700000000, senderUin: "333", speaker: "Replier" }),
      mediaMessage(targetHash, { rowId: "100", sentAt: 1700000090, senderUin: "111", speaker: "Author" }),
      mediaMessage(replyHash, { rowId: "300", sentAt: 1700000120, senderUin: "333", speaker: "Replier" }),
    ],
    quoteLinks: [],
  });

  assert.equal(pairs[0].imageHash, null, "several earlier images are ambiguous without a quote");
  assert.equal(pairs[0].imageOwner, "");
  assert.equal(pairs[0].targetVia, "none");
  assert.equal(pairs[0].answerBy, "Replier");
});

test("upgrades a guessed target when the answer comes from its author", () => {
  // A long gap is fine when the answering author owns the image: real measured
  // gaps were 344-398s, because writing out a prompt takes time.
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000350, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000700, senderUin: "111", speaker: "Author", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32), { sentAt: 1700000000 })],
    quoteLinks: [],
  });

  assert.equal(pairs[0].imageHash, "a".repeat(32));
  assert.equal(pairs[0].targetVia, "answer-author");
  assert.equal(pairs[0].confidence, "medium");
});

test("stays weak when the answering author posted several candidate images", () => {
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000200, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000260, senderUin: "111", speaker: "Author", text: PROMPT_ANSWER },
    ],
    mediaMessages: [
      mediaMessage("a".repeat(32), { sentAt: 1700000000 }),
      mediaMessage("b".repeat(32), { rowId: "150", sentAt: 1700000100 }),
    ],
    quoteLinks: [],
  });

  assert.equal(pairs[0].imageHash, "b".repeat(32), "most recent of theirs");
  assert.equal(pairs[0].targetVia, "answer-author-multiple");
  assert.equal(pairs[0].confidence, "low");
});

test("drops a guessed target that the answering author contradicts", () => {
  // The guess said the image is Author's, but somebody else supplied the prompt,
  // so the image link is not evidence for that answer and must not be asserted.
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000060, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000100, senderUin: "333", speaker: "Someone Else", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [],
  });

  assert.equal(pairs[0].imageHash, null);
  assert.equal(pairs[0].targetVia, "guess-contradicted");
  assert.equal(pairs[0].confidence, "none");
  assert.equal(pairs[0].answerText, PROMPT_ANSWER, "the prompt is still worth keeping");
});

test("a quoted target survives an unrelated bystander's prompt", () => {
  // A quote is hard evidence; someone else pasting a prompt does not undo it.
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000060, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000100, senderUin: "333", speaker: "Bystander", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: ["a".repeat(32)] }],
  });

  assert.equal(pairs[0].imageHash, "a".repeat(32));
  assert.equal(pairs[0].confidence, "high");
});

test("strips stray protobuf control characters from stored text", () => {
  const dirty = `\u0006 ${PROMPT_ANSWER}`;
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000060, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000100, senderUin: "111", speaker: "Author", text: dirty },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [],
  });

  assert.equal(pairs[0].answerText, PROMPT_ANSWER);
  assert.ok(!pairs[0].answerText.includes("\u0006"));
});

test("records an unanswered ask, because the ask itself is a quality signal", () => {
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kkt" },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: ["a".repeat(32)] }],
  });

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].answerText, "");
  assert.equal(pairs[0].answerKind, "");
  assert.deepEqual(pairs[0].answerMedia, []);
  assert.equal(pairs[0].imageHash, "a".repeat(32));
});

test("does not accept the asker's own message as the answer", () => {
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "250", sentAt: 1700000150, senderUin: "222", speaker: "Asker", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: ["a".repeat(32)] }],
  });

  assert.equal(pairs[0].answerText, "");
});

test("ignores an answer that arrives long after the ask", () => {
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "300", sentAt: 1700000100 + 3600 * 3, senderUin: "111", speaker: "Author", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: ["a".repeat(32)] }],
  });

  assert.equal(pairs[0].answerText, "");
});

test("takes the first prompt-shaped reply, and records whether its author owns the image", () => {
  // The answer is NOT pre-filtered by image author: doing so lost real answers
  // whose image could not be identified up front. Whoever replies first is the
  // answer; agreement with the image owner is then expressed as confidence.
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "200", sentAt: 1700000100, senderUin: "222", speaker: "Asker", text: "kkt" },
      { groupId: "1001", rowId: "250", sentAt: 1700000120, senderUin: "333", speaker: "Bystander", text: PROMPT_ANSWER },
      { groupId: "1001", rowId: "300", sentAt: 1700000200, senderUin: "111", speaker: "Author", text: PROMPT_ANSWER },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [{ groupId: "1001", rowId: "200", quotedImageHashes: ["a".repeat(32)] }],
  });

  assert.equal(pairs[0].answerBy, "Bystander");
  // The quote still pins the image, so the pairing is usable even though the
  // replier is not the image's author.
  assert.equal(pairs[0].imageHash, "a".repeat(32));
  assert.equal(pairs[0].confidence, "high");
});

test("finds nothing in a conversation with no asks", () => {
  const pairs = pairPromptRequests({
    messages: [
      { groupId: "1001", rowId: "1", sentAt: 1700000000, senderUin: "1", speaker: "A", text: "这张图好看" },
      { groupId: "1001", rowId: "2", sentAt: 1700000010, senderUin: "2", speaker: "B", text: "确实，就是原图有点糊" },
    ],
    mediaMessages: [mediaMessage("a".repeat(32))],
    quoteLinks: [],
  });

  assert.deepEqual(pairs, []);
});

test("handles an export with no media or quote links at all", () => {
  assert.deepEqual(pairPromptRequests({ messages: [], mediaMessages: [], quoteLinks: [] }), []);
  assert.deepEqual(pairPromptRequests({}), []);
});
