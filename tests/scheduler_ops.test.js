"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { describeTaskResult } = require("../src/server/scheduler_ops");

test("scheduled task result distinguishes success, running, never run, and failure", () => {
  assert.deepEqual(describeTaskResult(0), { status: "success", text: "上次运行成功", code: "0x00000000" });
  assert.deepEqual(describeTaskResult(267009), { status: "running", text: "正在运行", code: "0x00041301" });
  assert.deepEqual(describeTaskResult(267011), { status: "never-run", text: "尚未运行", code: "0x00041303" });
  assert.deepEqual(describeTaskResult(1), { status: "failed", text: "上次运行失败（0x00000001）", code: "0x00000001" });
});
