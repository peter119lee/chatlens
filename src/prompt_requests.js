"use strict";

// Detects "show me the prompt / original" requests in AIGC groups and pairs them
// with the image asked about and the author's answer.
//
// The shape of the exchange being matched:
//   1. Someone posts an image.
//   2. Someone else replies to it with "kkt" (prompt), "kko"/"kky" (original
//      with metadata), or a Chinese equivalent.
//   3. The original poster answers with prompt text for kkt, or sends an image
//      or file for kko/kky.
//
// Step 2 is resolved to a specific image via quoteLinks (the quoted image ref
// the exporter used to discard). Step 3 is matched by author + time proximity,
// which is why a matched pair records how it was matched: a caller can decide
// how much to trust it.
//
// Why not substring matching for the Chinese forms: measured against 57k real
// messages, plain substring on 原图 / 康康 / 求 has a false-positive rate above
// 70% -- "这是原图", "截图比你发原图还清晰啊", "他发的都是原图" are statements,
// not requests. The rules below therefore require request-shaped context.

const KK_PATTERN = /^kk([tokyp])\b/iu;

// The kk-family letters, as used in these groups.
const KK_INTENT = {
  t: "prompt",
  o: "original",
  y: "original",
  p: "prompt",
};

const ORIGINAL_REPLY_KINDS = new Set(["image", "file"]);
const HASH_PATTERN = /^[a-f0-9]{32}$/iu;

// Whole-message asks: the entire message is the request, nothing else.
// Anchored, so "这是原图" cannot match.
const EXACT_ASK_PATTERNS = [
  { pattern: /^原图[呢吗？?！!。，,\s]*$/u, intent: "original" },
  { pattern: /^康康[呀吧？?！!。，,\s]*$/u, intent: "prompt" },
  { pattern: /^(?:求|要|想看|讨|跪求)(?:一?[下个]?)?(?:tag|prompt|提示词|咒语?|参数)[呀吧？?！!。，,\s]*$/iu, intent: "prompt" },
  { pattern: /^(?:求|要|想看|讨|跪求)(?:一?[下个]?)?原图[呀吧？?！!。，,\s]*$/u, intent: "original" },
  { pattern: /^(?:看看|康康|发个?|出个?|来个?)(?:tag|prompt|提示词|咒语?|工作流)[呀吧？?！!。，,\s]*$/iu, intent: "prompt" },
  { pattern: /^(?:看看|康康)原图[呀吧？?！!。，,\s]*$/u, intent: "original" },
];

// Requests embedded in a longer sentence. Measured against real messages, a
// quoted image is NOT sufficient context to make these safe -- replies quote an
// image while merely commenting on it ("截图比你发原图还清晰啊"). So each pattern
// must express an imperative aimed at the other person: an ask verb, the object,
// and a recipient marker (我/来/过来) or a trailing 康康/看看.
// Patterns that could not be made specific enough were dropped rather than
// shipped noisy -- the kk-family forms carry the overwhelming majority of asks.
const CONTEXTUAL_ASK_PATTERNS = [
  { pattern: /(?:^|[\s，,])(?:发|给|甩|扔)(?:我|来|过来)(?:一?[下个张]?)?\s*原图/u, intent: "original" },
  { pattern: /原图\s*(?:发|给|甩|扔)(?:我|来|过来)/u, intent: "original" },
  { pattern: /(?:tag|prompt|提示词|咒语?|工作流|参数)\s*(?:发|给|甩)(?:我|来|过来)(?:康康|看看)?/iu, intent: "prompt" },
  { pattern: /(?:求|讨|跪求)(?:一?[下个]?)\s*(?:tag|prompt|提示词|咒语?|工作流)/iu, intent: "prompt" },
];

// A statement about an image, even one that quotes it, is not a request. These
// override any pattern match: they mark the message as commentary.
const NOT_AN_ASK_PATTERNS = [
  /是什么|什么意思|啥意思/u,
  // Comparisons and assertions rather than asks.
  /比你|比我|还清晰|还好|就是|不是|没有|我没|应该|可能|因为|已经|之前|好像/u,
  // Reports of a past action.
  /给我爆回去|我发过|我传过|我保留/u,
];

// A request is short by nature. Anything longer is discussion that happens to
// contain the words, and is left alone.
const MAX_EXACT_ASK_CHARS = 12;
const MAX_CONTEXTUAL_ASK_CHARS = 30;

// Protobuf text extraction leaves stray control bytes at segment boundaries
// (a leading U+0006 is common), which would otherwise be stored as part of the
// prompt and corrupt any later comparison against the same prompt read from
// image metadata. \t and \n are preserved: pasted prompts are often multi-line.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/gu;

const cleanExtractedText = (text) => String(text ?? "").replace(CONTROL_CHARS, "").trim();

const normalizeAsk = (text) => cleanExtractedText(text);

// Returns { intent, rule } or null. `rule` records which path matched so the
// pairing output stays auditable.
const classifyAsk = (text, hasQuotedImage) => {
  const message = normalizeAsk(text);
  if (message.length === 0) {
    return null;
  }

  const kk = message.match(KK_PATTERN);
  if (kk !== null) {
    // "kkt是什么" is someone asking what the slang means, not using it.
    if (/是什么|什么意思|啥意思/u.test(message)) {
      return null;
    }
    return { intent: KK_INTENT[kk[1].toLowerCase()], rule: `kk:${kk[1].toLowerCase()}` };
  }

  if (message.length <= MAX_EXACT_ASK_CHARS) {
    for (const { pattern, intent } of EXACT_ASK_PATTERNS) {
      if (pattern.test(message)) {
        return { intent, rule: "exact" };
      }
    }
  }

  // Contextual forms are ambiguous on their own; require a quoted image AND the
  // absence of any commentary marker.
  if (hasQuotedImage && message.length <= MAX_CONTEXTUAL_ASK_CHARS) {
    if (NOT_AN_ASK_PATTERNS.some((pattern) => pattern.test(message))) {
      return null;
    }
    for (const { pattern, intent } of CONTEXTUAL_ASK_PATTERNS) {
      if (pattern.test(message)) {
        return { intent, rule: "contextual" };
      }
    }
  }
  return null;
};

// --- answer detection ------------------------------------------------------

// A pasted prompt looks unlike chat. Counting comma-separated segments is NOT
// enough: conversational Chinese is comma-heavy, and measured against 13.6k real
// messages a segment-shape heuristic alone matched 142 messages of which almost
// all were prose. Positive evidence of prompt vocabulary is required instead.
const A1111_MARKERS = /(?:Negative prompt:|Steps:\s*\d+|Sampler:|CFG scale:|Model hash:)/iu;

// Tokens that appear in generation prompts and effectively never in chat.
const PROMPT_VOCABULARY = [
  /\b(?:masterpiece|best quality|amazing quality|absurdres|highres|lowres|very aesthetic)\b/iu,
  /\b(?:worst quality|low quality|normal quality|jpeg artifacts|bad anatomy|extra digits)\b/iu,
  /\b\d?(?:girl|boy)s?\b/iu,
  /\b(?:solo|looking at viewer|full body|upper body|cowboy shot|portrait)\b/iu,
  /<lora:[^>]+>/iu,
  /\b(?:score_\d|source_anime|rating:\s*\w+)\b/iu,
  /\b(?:artist:|year 20\d\d)\b/iu,
  /(?:^|[,，])\s*(?:1girl|1boy|2girls)\b/iu,
];

// Weighted so one stray English word cannot qualify a sentence.
const MIN_VOCABULARY_HITS = 2;
const MIN_PROMPT_SEGMENTS = 4;
const MIN_PROMPT_CHARS = 24;
const MAX_SEGMENT_CHARS = 40;

// Han-heavy text with sentence punctuation is chat, whatever else it contains.
const readsAsProse = (message) => {
  const han = (message.match(/\p{Script=Han}/gu) ?? []).length;
  const hasSentenceMarks = /[。！？!?；]/u.test(message);
  return hasSentenceMarks && han / message.length > 0.3;
};

const looksLikePromptText = (text) => {
  const message = String(text ?? "").trim();
  if (message.length < MIN_PROMPT_CHARS) {
    return false;
  }
  // Parameter lines are unambiguous and outrank every other consideration.
  if (A1111_MARKERS.test(message)) {
    return true;
  }
  if (readsAsProse(message)) {
    return false;
  }

  const vocabularyHits = PROMPT_VOCABULARY.filter((pattern) => pattern.test(message)).length;
  if (vocabularyHits < MIN_VOCABULARY_HITS) {
    return false;
  }

  const segments = message.split(/[,，\n]/u).map((part) => part.trim()).filter((part) => part.length > 0);
  const shortSegments = segments.filter((part) => part.length <= MAX_SEGMENT_CHARS).length;
  return segments.length >= MIN_PROMPT_SEGMENTS && shortSegments >= MIN_PROMPT_SEGMENTS;
};

const normalizeOriginalReplyMedia = (mediaRefs) => {
  if (!Array.isArray(mediaRefs)) {
    return [];
  }
  return mediaRefs.flatMap((ref) => {
    if (typeof ref !== "object" || ref === null || !ORIGINAL_REPLY_KINDS.has(ref.kind)) {
      return [];
    }
    const rawHash = typeof ref.hash === "string" ? ref.hash.toLowerCase() : "";
    const hash = HASH_PATTERN.test(rawHash) ? rawHash : null;
    const fileName = typeof ref.fileName === "string" ? ref.fileName.trim() : "";
    if (hash === null && fileName === "") {
      return [];
    }
    return [{ kind: ref.kind, hash, fileName }];
  });
};

// How long after the ask an answer is still considered a reply to it.
const ANSWER_WINDOW_SECONDS = 30 * 60;
const ORIGINAL_ANSWER_WINDOW_SECONDS = 2 * 60;

const sameSender = (left, right) =>
  String(left ?? "") !== "" && String(left ?? "") === String(right ?? "");

// --- pairing ---------------------------------------------------------------

const indexQuoteLinks = (quoteLinks) => {
  const byRow = new Map();
  for (const link of quoteLinks ?? []) {
    byRow.set(`${link.groupId}|${link.rowId}`, link);
  }
  return byRow;
};

// hash -> who posted it and when, from the images in this export.
const indexImageOwners = (mediaMessages) => {
  const owners = new Map();
  for (const message of mediaMessages ?? []) {
    for (const ref of message.mediaRefs ?? []) {
      if (ref.kind !== "image" || typeof ref.hash !== "string") {
        continue;
      }
      if (!owners.has(ref.hash)) {
        owners.set(ref.hash, {
          hash: ref.hash,
          groupId: String(message.groupId),
          rowId: String(message.rowId),
          sentAt: Number(message.sentAt ?? 0),
          senderUin: String(message.senderUin ?? ""),
          speaker: message.speaker || message.senderName || message.memberName || "",
        });
      }
    }
  }
  return owners;
};

// Finds the image an ask is about, given the answer if one was found.
//
// Evidence, strongest first:
//   quote     the reply embedded the image ref -- authoritative
//   author    the person who answered had posted exactly one image before the
//             ask; that agreement is strong, and tolerates a long gap because
//             answering takes time (measured real gaps: 344s, 386s, 398s)
//   single    exactly one image in the seconds before the ask, nobody to
//             corroborate -- offered as a weak candidate
// Otherwise nothing. QQ does not re-embed the quoted image in a plain text
// reply, so most asks have no join key at all; guessing the latest of the ~10
// images posted in the preceding 15 minutes agreed with the answering author
// only 38% of the time, which is worse than admitting ignorance.
const AUTHOR_MATCH_WINDOW_SECONDS = 30 * 60;
const GUESS_WINDOW_SECONDS = 120;
const MAX_COMPETING_IMAGES = 1;

const imagesBefore = (imageOwners, ask, windowSeconds) =>
  [...imageOwners.values()].filter((owner) =>
    owner.groupId === ask.groupId
    && owner.sentAt <= ask.sentAt
    && ask.sentAt - owner.sentAt <= windowSeconds);

const resolveTargetImage = (ask, quoteLink, imageOwners, answer = null) => {
  if (quoteLink !== undefined) {
    for (const hash of quoteLink.quotedImageHashes) {
      const owner = imageOwners.get(hash);
      if (owner !== undefined) {
        return { image: owner, via: "quote", confidence: "high" };
      }
      return {
        image: { hash, groupId: ask.groupId, rowId: "", sentAt: 0, senderUin: "", speaker: "" },
        via: "quote-unresolved",
        confidence: "medium",
      };
    }
  }

  // The answering author's own recent image is the best non-quote evidence.
  if (answer !== null && String(answer.senderUin ?? "") !== "") {
    const theirs = imagesBefore(imageOwners, ask, AUTHOR_MATCH_WINDOW_SECONDS)
      .filter((owner) => sameSender(owner.senderUin, answer.senderUin));
    if (theirs.length === 1) {
      return { image: theirs[0], via: "answer-author", confidence: "medium" };
    }
    if (theirs.length > 1) {
      // They posted several; the most recent before the ask is the likely one,
      // but with competition it stays a weak claim.
      const latest = theirs.reduce((best, owner) => (owner.sentAt > best.sentAt ? owner : best));
      return { image: latest, via: "answer-author-multiple", confidence: "low" };
    }
  }

  const nearby = imagesBefore(imageOwners, ask, GUESS_WINDOW_SECONDS);
  if (nearby.length === 0 || nearby.length > MAX_COMPETING_IMAGES) {
    return null;
  }
  return { image: nearby[0], via: "recent-unambiguous", confidence: "low" };
};

// Pairs asks with the image they target and the author's prompt-shaped answer.
// Returns one record per detected ask, including unanswered ones: an ask with no
// answer is still a signal that the image was worth asking about.
const pairPromptRequests = (exportData) => {
  const messages = exportData.messages ?? [];
  const quoteByRow = indexQuoteLinks(exportData.quoteLinks);
  const imageOwners = indexImageOwners(exportData.mediaMessages);

  const asks = [];
  for (const message of messages) {
    const quoteLink = quoteByRow.get(`${message.groupId}|${message.rowId}`);
    const classified = classifyAsk(message.text, quoteLink !== undefined);
    if (classified === null) {
      continue;
    }
    asks.push({
      groupId: String(message.groupId),
      groupName: message.groupName ?? "",
      rowId: String(message.rowId),
      sentAt: Number(message.sentAt ?? 0),
      senderUin: String(message.senderUin ?? ""),
      asker: message.speaker || message.senderName || message.memberName || "",
      text: normalizeAsk(message.text),
      intent: classified.intent,
      rule: classified.rule,
      quoteLink,
    });
  }

  const byTime = [...messages]
    .map((message) => ({
      groupId: String(message.groupId),
      sentAt: Number(message.sentAt ?? 0),
      senderUin: String(message.senderUin ?? ""),
      speaker: message.speaker || message.senderName || message.memberName || "",
      text: cleanExtractedText(message.text),
    }))
    .sort((left, right) => left.sentAt - right.sentAt);

  const mediaByTime = [...(exportData.mediaMessages ?? [])]
    .map((message) => ({
      groupId: String(message.groupId),
      sentAt: Number(message.sentAt ?? 0),
      senderUin: String(message.senderUin ?? message.memberUin ?? ""),
      speaker: message.speaker || message.senderName || message.memberName || "",
      media: normalizeOriginalReplyMedia(message.mediaRefs),
    }))
    .filter((message) => message.media.length > 0)
    .sort((left, right) => left.sentAt - right.sentAt);

  const pairs = [];
  for (const ask of asks) {
    // Answer first: its author is the strongest evidence for which image was
    // being asked about, so the target cannot be resolved before it is known.
    // Prompt requests accept prompt-shaped text. Original requests accept only
    // a subsequent image/file; unrelated text must never count as the answer.
    const answer = ask.intent === "original"
      ? mediaByTime.find((candidate) =>
        candidate.groupId === ask.groupId
        && candidate.sentAt >= ask.sentAt
        && candidate.sentAt - ask.sentAt <= ORIGINAL_ANSWER_WINDOW_SECONDS
        && !sameSender(candidate.senderUin, ask.senderUin)) ?? null
      : byTime.find((candidate) =>
        candidate.groupId === ask.groupId
        && candidate.sentAt >= ask.sentAt
        && candidate.sentAt - ask.sentAt <= ANSWER_WINDOW_SECONDS
        && !sameSender(candidate.senderUin, ask.senderUin)
        && looksLikePromptText(candidate.text)) ?? null;

    // A prompt answer usually comes from the image owner and can corroborate
    // the target. An original-image reply can be supplied by anybody, so its
    // sender must not be used to infer which earlier image was being requested.
    const targetEvidenceAnswer = ask.intent === "prompt" ? answer : null;
    const target = resolveTargetImage(ask, ask.quoteLink, imageOwners, targetEvidenceAnswer);

    // A quoted target that the answer contradicts is still reported: the quote
    // is hard evidence and an unrelated bystander pasting a prompt does not
    // undo it. Only a *guess* is withdrawn on contradiction.
    const contradicted = ask.intent === "prompt"
      && answer !== null
      && target !== null
      && target.confidence === "low"
      && target.image.senderUin !== ""
      && !sameSender(answer.senderUin, target.image.senderUin);

    const effectiveTarget = contradicted ? null : target;

    pairs.push({
      groupId: ask.groupId,
      groupName: ask.groupName,
      intent: ask.intent,
      rule: ask.rule,
      askRowId: ask.rowId,
      askSentAt: ask.sentAt,
      asker: ask.asker,
      askText: ask.text,
      imageHash: effectiveTarget?.image.hash ?? null,
      imageOwner: effectiveTarget?.image.speaker ?? "",
      imageSentAt: effectiveTarget?.image.sentAt ?? 0,
      targetVia: effectiveTarget?.via ?? (contradicted ? "guess-contradicted" : "none"),
      // How much to trust imageHash: high = quoted, medium = the answering
      // author's own image or an out-of-window quote, low = weak guess,
      // none = unresolved. Below medium it must not be shown as fact.
      confidence: effectiveTarget?.confidence ?? "none",
      answerKind: answer === null ? "" : (ask.intent === "original" ? "media" : "text"),
      answerText: ask.intent === "prompt" ? (answer?.text ?? "") : "",
      answerMedia: ask.intent === "original" ? (answer?.media ?? []) : [],
      answerBy: answer?.speaker ?? "",
      answerSentAt: answer?.sentAt ?? 0,
    });
  }
  return pairs;
};

module.exports = {
  pairPromptRequests,
  classifyAsk,
  looksLikePromptText,
  indexImageOwners,
  resolveTargetImage,
  normalizeOriginalReplyMedia,
};
