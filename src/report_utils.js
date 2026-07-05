const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const fileUrl = (filePath) => pathToFileURL(filePath).href;

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const isImagePath = (filePath) => /\.(?:jpg|jpeg|png|gif|webp|bmp)$/iu.test(filePath);

const isVideoPath = (filePath) => /\.(?:mp4|mov|webm|mkv|avi)$/iu.test(filePath);

module.exports = {
  readJson,
  escapeHtml,
  fileUrl,
  formatBytes,
  isImagePath,
  isVideoPath,
};
