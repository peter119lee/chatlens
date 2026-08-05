"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { exportMediaFiles } = require("../src/export_media_files");

const NETWORK_TEST_ENABLED = process.env.QQ_RUN_NETWORK_TESTS === "1";
const KNOWN_GROUP_IMAGE_MD5 = "c65794f4ba770c526d83e7321bbff6c8";

test("media export downloads a cache miss from the official QQ group image CDN", { skip: !NETWORK_TEST_ENABLED }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-media-export-"));
  try {
    const ntDataDir = path.join(tempDir, "nt_data");
    const outputDir = path.join(tempDir, "media");
    const objectDir = path.join(tempDir, "store", "media-objects");
    const knowledgeStorePath = path.join(tempDir, "store", "knowledge.db");
    const mediaMessagesJson = path.join(tempDir, "media-messages.json");
    fs.mkdirSync(ntDataDir, { recursive: true });
    fs.writeFileSync(mediaMessagesJson, JSON.stringify([{
      rowId: "1",
      hkt: "2026-08-04 18:32:39",
      groupId: "827917412",
      groupName: "test-group",
      speaker: "test-user",
      mediaRefs: [{
        kind: "image",
        extension: ".jpg",
        hash: KNOWN_GROUP_IMAGE_MD5,
        fileName: `${KNOWN_GROUP_IMAGE_MD5}.jpg`,
        localPath: null,
        url: null,
      }],
    }]), "utf8");

    await exportMediaFiles({
      mediaMessagesJson,
      ntDataDir,
      outputDir,
      formats: ["jpg", "jpeg", "png", "gif", "webp"],
      objectDir,
      knowledgeStorePath,
      toolRoot: tempDir,
    }, globalThis.fetch);

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "media-manifest.json"), "utf8"));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].remoteStatus, "downloaded");
    assert.equal(manifest[0].remoteStatusCode, 200);
    assert.equal(path.extname(manifest[0].copiedPath), ".gif");
    const actualHash = crypto.createHash("md5").update(fs.readFileSync(manifest[0].copiedPath)).digest("hex");
    assert.equal(actualHash, KNOWN_GROUP_IMAGE_MD5);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
