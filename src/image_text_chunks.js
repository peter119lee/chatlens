"use strict";

// Container-level text extraction for AI image metadata.
// Reads PNG text chunks and JPEG EXIF text tags WITHOUT loading pixel data:
// chunk headers are read one at a time and image payloads are seeked past, so a
// 7 MB PNG costs a handful of small reads. Everything here is byte-level; no
// image decoding and no third-party dependency.

const fs = require("node:fs");
const zlib = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT_TYPES = new Set(["tEXt", "zTXt", "iTXt"]);

// Chunks above the per-chunk cap are skipped, not truncated: a half prompt is
// worse than a recorded miss. The total cap stops a crafted file from making us
// buffer the whole image as "text".
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 512;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

const LATIN1 = "latin1";

const readExact = (fd, offset, length) => {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, offset);
  return read === length ? buffer : null;
};

const inflateText = (buffer) => {
  try {
    return zlib.inflateSync(buffer, { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
  } catch {
    return null;
  }
};

const splitAtNull = (buffer, from) => {
  const index = buffer.indexOf(0, from);
  return index === -1 ? null : { value: buffer.subarray(from, index), next: index + 1 };
};

// tEXt: keyword \0 latin1-text
// zTXt: keyword \0 method(1) deflate(text)
// iTXt: keyword \0 flag(1) method(1) language \0 translated \0 utf8-text[deflated]
const decodePngTextChunk = (type, data) => {
  const keyword = splitAtNull(data, 0);
  if (keyword === null) {
    return null;
  }
  const key = keyword.value.toString(LATIN1);

  if (type === "tEXt") {
    return { key, value: data.subarray(keyword.next).toString(LATIN1) };
  }

  if (type === "zTXt") {
    const value = inflateText(data.subarray(keyword.next + 1));
    return value === null ? null : { key, value };
  }

  const compressed = data[keyword.next] === 1;
  const language = splitAtNull(data, keyword.next + 2);
  if (language === null) {
    return null;
  }
  const translated = splitAtNull(data, language.next);
  if (translated === null) {
    return null;
  }
  const payload = data.subarray(translated.next);
  const value = compressed ? inflateText(payload) : payload.toString("utf8");
  return value === null ? null : { key, value };
};

const readPngChunks = (fd, fileSize) => {
  const signature = readExact(fd, 0, PNG_SIGNATURE.length);
  if (signature === null || !signature.equals(PNG_SIGNATURE)) {
    return null;
  }

  const chunks = {};
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let textBytes = 0;
  let seen = 0;

  while (offset + 8 <= fileSize && seen < MAX_CHUNKS) {
    const header = readExact(fd, offset, 8);
    if (header === null) {
      break;
    }
    const length = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString(LATIN1);
    const dataOffset = offset + 8;
    if (length > fileSize - dataOffset) {
      break;
    }
    seen += 1;

    if (type === "IHDR" && length >= 8) {
      const ihdr = readExact(fd, dataOffset, 8);
      if (ihdr !== null) {
        width = ihdr.readUInt32BE(0);
        height = ihdr.readUInt32BE(4);
      }
    } else if (PNG_TEXT_TYPES.has(type) && length <= MAX_CHUNK_BYTES && textBytes + length <= MAX_TOTAL_TEXT_BYTES) {
      const data = readExact(fd, dataOffset, length);
      const decoded = data === null ? null : decodePngTextChunk(type, data);
      if (decoded !== null && !(decoded.key in chunks)) {
        chunks[decoded.key] = decoded.value;
        textBytes += length;
      }
    } else if (type === "IEND") {
      break;
    }

    offset = dataOffset + length + 4;
  }

  return { container: "png", chunks, width, height };
};

// --- JPEG / EXIF -----------------------------------------------------------

const EXIF_TAGS = {
  0x010e: "ImageDescription",
  0x0131: "Software",
  0x9286: "UserComment",
};
const EXIF_SUB_IFD_TAG = 0x8769;
const MAX_IFD_ENTRIES = 512;

// UserComment is prefixed with an 8-byte character code. NovelAI and several
// exporters write UTF-16 here, following the TIFF byte order rather than the
// spec's big-endian wording, so honour the container's endianness.
const decodeUserComment = (buffer, littleEndian) => {
  const code = buffer.subarray(0, 8).toString(LATIN1).replace(/\0+$/u, "");
  const payload = buffer.subarray(8);
  if (code === "UNICODE") {
    const swapped = littleEndian ? payload : payload.swap16();
    return swapped.toString("utf16le").replace(/\0+$/u, "");
  }
  return payload.toString("utf8").replace(/\0+$/u, "");
};

const readIfd = (tiff, ifdOffset, littleEndian, tags, out) => {
  if (ifdOffset + 2 > tiff.length) {
    return null;
  }
  const count = littleEndian ? tiff.readUInt16LE(ifdOffset) : tiff.readUInt16BE(ifdOffset);
  if (count > MAX_IFD_ENTRIES) {
    return null;
  }

  let subIfdOffset = null;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > tiff.length) {
      break;
    }
    const tag = littleEndian ? tiff.readUInt16LE(entry) : tiff.readUInt16BE(entry);
    const size = littleEndian ? tiff.readUInt32LE(entry + 4) : tiff.readUInt32BE(entry + 4);
    const rawValue = littleEndian ? tiff.readUInt32LE(entry + 8) : tiff.readUInt32BE(entry + 8);

    if (tag === EXIF_SUB_IFD_TAG) {
      subIfdOffset = rawValue;
      continue;
    }
    const name = tags[tag];
    if (name === undefined || size > MAX_CHUNK_BYTES) {
      continue;
    }
    // Values of 4 bytes or fewer are stored inline in the offset field itself.
    const valueOffset = size <= 4 ? entry + 8 : rawValue;
    if (valueOffset + size > tiff.length) {
      continue;
    }
    const raw = tiff.subarray(valueOffset, valueOffset + size);
    out[name] = name === "UserComment"
      ? decodeUserComment(raw, littleEndian)
      : raw.toString(LATIN1).replace(/\0+$/u, "");
  }
  return subIfdOffset;
};

const parseExif = (tiff) => {
  if (tiff.length < 8) {
    return {};
  }
  const order = tiff.subarray(0, 2).toString(LATIN1);
  if (order !== "II" && order !== "MM") {
    return {};
  }
  const littleEndian = order === "II";
  const ifd0 = littleEndian ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);

  const out = {};
  const subIfdOffset = readIfd(tiff, ifd0, littleEndian, EXIF_TAGS, out);
  if (subIfdOffset !== null) {
    readIfd(tiff, subIfdOffset, littleEndian, EXIF_TAGS, out);
  }
  return out;
};

const readJpegChunks = (fd, fileSize) => {
  const start = readExact(fd, 0, 2);
  if (start === null || start[0] !== 0xff || start[1] !== 0xd8) {
    return null;
  }

  const chunks = {};
  let offset = 2;
  let width = 0;
  let height = 0;
  let seen = 0;

  while (offset + 4 <= fileSize && seen < MAX_CHUNKS) {
    const header = readExact(fd, offset, 4);
    if (header === null || header[0] !== 0xff) {
      break;
    }
    const marker = header[1];
    // Start of scan: everything after this is entropy-coded pixel data.
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    const length = header.readUInt16BE(2);
    if (length < 2) {
      break;
    }
    const dataOffset = offset + 4;
    const dataLength = length - 2;
    seen += 1;

    // SOF0..SOF15 carry the real dimensions (skipping the DHT/DAC/DNL markers).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc && marker !== 0xc8) {
      const sof = readExact(fd, dataOffset, 5);
      if (sof !== null) {
        height = sof.readUInt16BE(1);
        width = sof.readUInt16BE(3);
      }
    } else if (marker === 0xe1 && dataLength <= MAX_CHUNK_BYTES) {
      const data = readExact(fd, dataOffset, dataLength);
      if (data !== null && data.subarray(0, 4).toString(LATIN1) === "Exif") {
        Object.assign(chunks, parseExif(data.subarray(6)));
      }
    }

    offset = dataOffset + dataLength;
  }

  return { container: "jpeg", chunks, width, height };
};

// Returns { container, chunks, width, height } or null when the file is neither
// a readable PNG nor JPEG. Never throws on malformed input.
const readImageTextChunks = (filePath) => {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 16) {
      return null;
    }
    fd = fs.openSync(filePath, "r");
    return readPngChunks(fd, stat.size) ?? readJpegChunks(fd, stat.size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
};

module.exports = {
  readImageTextChunks,
  // exported for tests
  decodePngTextChunk,
  parseExif,
};
