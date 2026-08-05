"use strict";

const crypto = require("node:crypto");

const COVERAGE_REPAIR_PLAN_VERSION = 1;
const COVERAGE_REPAIR_CHUNK_SECONDS = 24 * 60 * 60;

const requiredInteger = (value, field) => {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new TypeError(`${field} must be an integer. value=${value}`);
  }
  return number;
};

const normalizeGroupIds = (value, batchIndex) => {
  if (!Array.isArray(value)) {
    throw new TypeError(`补扫批次 ${batchIndex + 1} 的 groupIds 必须是数组。`);
  }
  const groupIds = [...new Set(value.map(String).map((item) => item.trim()))];
  if (groupIds.length === 0) {
    throw new Error(`补扫批次 ${batchIndex + 1} 至少包含一个群。`);
  }
  if (groupIds.some((groupId) => !/^\d+$/u.test(groupId))) {
    throw new Error(`补扫批次 ${batchIndex + 1} 的群号必须是纯数字。`);
  }
  return groupIds.sort();
};

const normalizeRepairBatches = (batches) => {
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new Error("没有可补扫的缺口批次。");
  }
  return batches.map((batch, index) => {
    const startUnix = requiredInteger(batch?.startUnix, `batches[${index}].startUnix`);
    const endUnix = requiredInteger(batch?.endUnix, `batches[${index}].endUnix`);
    if (startUnix <= 0 || startUnix >= endUnix) {
      throw new Error(`补扫批次 ${index + 1} 的补扫时间范围无效: ${startUnix}-${endUnix}`);
    }
    return {
      groupIds: normalizeGroupIds(batch?.groupIds, index),
      startUnix,
      endUnix,
    };
  });
};

const mergeRanges = (ranges) => {
  const sorted = ranges
    .map((range) => ({ startUnix: range.startUnix, endUnix: range.endUnix }))
    .sort((left, right) => left.startUnix - right.startUnix || left.endUnix - right.endUnix);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.startUnix > previous.endUnix) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      startUnix: previous.startUnix,
      endUnix: Math.max(previous.endUnix, range.endUnix),
    };
  }
  return merged;
};

const taskIdFor = (groupId, startUnix, endUnix) =>
  crypto.createHash("sha256").update(`${groupId}:${startUnix}:${endUnix}`).digest("hex").slice(0, 20);

const splitRange = (groupId, range, chunkSeconds) => {
  const tasks = [];
  for (let startUnix = range.startUnix; startUnix < range.endUnix; startUnix += chunkSeconds) {
    const endUnix = Math.min(startUnix + chunkSeconds, range.endUnix);
    tasks.push({
      id: taskIdFor(groupId, startUnix, endUnix),
      groupId,
      startUnix,
      endUnix,
    });
  }
  return tasks;
};

const planIdForTasks = (tasks) =>
  crypto.createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 24);

const createCoverageRepairPlan = (batches, chunkSeconds) => {
  const normalizedChunkSeconds = requiredInteger(chunkSeconds, "chunkSeconds");
  if (normalizedChunkSeconds <= 0) {
    throw new RangeError(`chunkSeconds must be positive. value=${normalizedChunkSeconds}`);
  }
  const normalized = normalizeRepairBatches(batches);
  const rangesByGroup = new Map();
  for (const batch of normalized) {
    for (const groupId of batch.groupIds) {
      rangesByGroup.set(groupId, [
        ...(rangesByGroup.get(groupId) ?? []),
        { startUnix: batch.startUnix, endUnix: batch.endUnix },
      ]);
    }
  }
  const tasks = [...rangesByGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([groupId, ranges]) =>
      mergeRanges(ranges).flatMap((range) => splitRange(groupId, range, normalizedChunkSeconds)));
  const totalGroupSeconds = tasks.reduce((total, task) => total + task.endUnix - task.startUnix, 0);
  return {
    version: COVERAGE_REPAIR_PLAN_VERSION,
    planId: planIdForTasks(tasks),
    chunkSeconds: normalizedChunkSeconds,
    sourceBatchCount: normalized.length,
    groupCount: rangesByGroup.size,
    totalGroupSeconds,
    tasks,
  };
};

const validateCoverageRepairPlan = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Coverage repair plan must be an object.");
  }
  if (value.version !== COVERAGE_REPAIR_PLAN_VERSION) {
    throw new Error(`Unsupported coverage repair plan version: ${value.version}`);
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error("Coverage repair plan must contain at least one task.");
  }
  const chunkSeconds = requiredInteger(value.chunkSeconds, "chunkSeconds");
  if (chunkSeconds <= 0) {
    throw new Error(`Coverage repair chunkSeconds must be positive. value=${chunkSeconds}`);
  }
  const tasks = value.tasks.map((task, index) => {
    const groupId = String(task?.groupId ?? "").trim();
    const startUnix = requiredInteger(task?.startUnix, `tasks[${index}].startUnix`);
    const endUnix = requiredInteger(task?.endUnix, `tasks[${index}].endUnix`);
    if (!/^\d+$/u.test(groupId) || startUnix <= 0 || startUnix >= endUnix || endUnix - startUnix > chunkSeconds) {
      throw new Error(`Invalid coverage repair task at index ${index}.`);
    }
    const id = taskIdFor(groupId, startUnix, endUnix);
    if (task.id !== id) {
      throw new Error(`Coverage repair task id mismatch at index ${index}. expected=${id} actual=${task.id}`);
    }
    return { id, groupId, startUnix, endUnix };
  });
  const planId = planIdForTasks(tasks);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("Coverage repair plan contains duplicate tasks.");
  }
  if (value.planId !== planId) {
    throw new Error(`Coverage repair plan id mismatch. expected=${planId} actual=${value.planId}`);
  }
  const sourceBatchCount = requiredInteger(value.sourceBatchCount, "sourceBatchCount");
  if (sourceBatchCount <= 0) {
    throw new Error(`Coverage repair sourceBatchCount must be positive. value=${sourceBatchCount}`);
  }
  const groupCount = new Set(tasks.map((task) => task.groupId)).size;
  const totalGroupSeconds = tasks.reduce((total, task) => total + task.endUnix - task.startUnix, 0);
  if (requiredInteger(value.groupCount, "groupCount") !== groupCount) {
    throw new Error(`Coverage repair groupCount mismatch. expected=${groupCount} actual=${value.groupCount}`);
  }
  if (requiredInteger(value.totalGroupSeconds, "totalGroupSeconds") !== totalGroupSeconds) {
    throw new Error(
      `Coverage repair totalGroupSeconds mismatch. expected=${totalGroupSeconds} actual=${value.totalGroupSeconds}`,
    );
  }
  return {
    version: COVERAGE_REPAIR_PLAN_VERSION,
    planId,
    chunkSeconds,
    sourceBatchCount,
    groupCount,
    totalGroupSeconds,
    tasks,
  };
};

module.exports = {
  COVERAGE_REPAIR_CHUNK_SECONDS,
  COVERAGE_REPAIR_PLAN_VERSION,
  createCoverageRepairPlan,
  normalizeRepairBatches,
  validateCoverageRepairPlan,
};
