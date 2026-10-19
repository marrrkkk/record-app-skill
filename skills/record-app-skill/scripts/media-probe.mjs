/**
 * Dependency-free container probing for WebM/Matroska and MP4.
 *
 * Why this exists: Playwright's bundled FFmpeg has no ffprobe, and the skill
 * must not claim success when it cannot measure the output. Probing the
 * container ourselves means the recording can always be checked for codec,
 * dimensions, duration, frame count and audio streams — even on a machine with
 * no system FFmpeg at all. When system ffprobe *is* available,
 * `validate-video.mjs` cross-checks these numbers against it.
 *
 * Only the fields needed for validation are parsed. This is deliberately not a
 * general-purpose demuxer.
 */

import fs from "node:fs";

/* ------------------------------------------------------------------ */
/* EBML / Matroska (WebM)                                              */
/* ------------------------------------------------------------------ */

const EBML = {
  EBML_HEADER: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  TRACK_NUMBER: 0xd7,
  CODEC_ID: 0x86,
  DEFAULT_DURATION: 0x23e383,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  AUDIO: 0xe1,
  CLUSTER: 0x1f43b675,
  CUES: 0x1c53bb6b,
  TAGS: 0x1254c367,
  CHAPTERS: 0x1043a770,
  ATTACHMENTS: 0x1941a469,
};

/** Elements whose payload is a list of child elements. */
const EBML_MASTERS = new Set([
  EBML.EBML_HEADER,
  EBML.SEGMENT,
  EBML.SEEK_HEAD,
  EBML.INFO,
  EBML.TRACKS,
  EBML.TRACK_ENTRY,
  EBML.VIDEO,
  EBML.AUDIO,
  EBML.CUES,
  EBML.TAGS,
  EBML.CHAPTERS,
  EBML.ATTACHMENTS,
]);

const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;

/** Read an EBML variable-length integer. Returns { value, length } or null. */
function readVint(buf, offset, keepMarker) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[offset + i];
  return { value, length };
}

/** True when a vint's payload is all ones, meaning "unknown size". */
function isUnknownSize(buf, offset, length) {
  const mask = 0x80 >> (length - 1);
  if ((buf[offset] & (mask - 1)) !== mask - 1) return false;
  for (let i = 1; i < length; i++) {
    if (buf[offset + i] !== 0xff) return false;
  }
  return true;
}

function readUInt(buf, offset, length) {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + buf[offset + i];
  return v;
}

function readFloat(buf, offset, length) {
  if (length === 4) return buf.readFloatBE(offset);
  if (length === 8) return buf.readDoubleBE(offset);
  return NaN;
}

function readString(buf, offset, length) {
  return buf.subarray(offset, offset + length).toString("utf8").replace(/\0+$/, "");
}

/**
 * Walk EBML elements in [start, end). Master elements are descended into so
 * nested metadata (Info, Tracks, TrackEntry, Video) is reached. Unknown-size
 * masters are treated as "extends to the end of the parent", which is how
 * streamed WebM is written.
 *
 * `visit` returns "stop" to abort the whole walk.
 */
function walkEbml(buf, start, end, visit, depth = 0, budget = { n: 100000 }) {
  let offset = start;
  while (offset < end && depth < 8 && budget.n-- > 0) {
    const id = readVint(buf, offset, true);
    if (!id) return;
    const idEnd = offset + id.length;
    const size = readVint(buf, idEnd, false);
    if (!size) return;
    const dataStart = idEnd + size.length;
    let dataEnd;
    if (isUnknownSize(buf, idEnd, size.length)) {
      dataEnd = end;
    } else {
      dataEnd = dataStart + size.value;
      if (dataEnd > end) dataEnd = end;
    }
    const verdict = visit(id.value, buf, dataStart, dataEnd, depth);
    if (verdict === "stop") return;
    if (verdict !== "skip" && EBML_MASTERS.has(id.value)) {
      walkEbml(buf, dataStart, dataEnd, visit, depth + 1, budget);
    }
    if (dataEnd <= offset) return;
    offset = dataEnd;
  }
}

function probeWebm(buf) {
  const result = {
    container: "webm",
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    durationSeconds: null,
    nbFrames: null,
    fps: null,
    hasAudio: false,
  };

  const state = { timecodeScale: 1_000_000, durationRaw: null, tracks: [] };
  let currentTrack = null;

  walkEbml(buf, 0, buf.length, (id, b, s, e) => {
    switch (id) {
      case EBML.TIMECODE_SCALE:
        state.timecodeScale = readUInt(b, s, e - s);
        return "skip";
      case EBML.DURATION:
        state.durationRaw = readFloat(b, s, e - s);
        return "skip";
      case EBML.TRACK_ENTRY:
        currentTrack = { type: null, codecId: null, width: null, height: null, defaultDuration: null };
        state.tracks.push(currentTrack);
        // TrackEntry is a master; descend, then treat its children below.
        return true;
      case EBML.TRACK_TYPE:
        if (currentTrack) currentTrack.type = readUInt(b, s, e - s);
        return "skip";
      case EBML.CODEC_ID:
        if (currentTrack) currentTrack.codecId = readString(b, s, e - s);
        return "skip";
      case EBML.DEFAULT_DURATION:
        if (currentTrack) currentTrack.defaultDuration = readUInt(b, s, e - s);
        return "skip";
      case EBML.PIXEL_WIDTH:
        if (currentTrack) currentTrack.width = readUInt(b, s, e - s);
        return "skip";
      case EBML.PIXEL_HEIGHT:
        if (currentTrack) currentTrack.height = readUInt(b, s, e - s);
        return "skip";
      case EBML.CLUSTER:
        // Media data holds nothing we need; stop once metadata is in hand.
        return state.durationRaw !== null && state.tracks.length > 0 ? "stop" : "skip";
      default:
        return false;
    }
  });

  const video = state.tracks.find((t) => t.type === TRACK_TYPE_VIDEO);
  const audio = state.tracks.find((t) => t.type === TRACK_TYPE_AUDIO);
  if (video) {
    result.videoCodec = normalizeWebmCodec(video.codecId);
    result.width = video.width;
    result.height = video.height;
    if (video.defaultDuration) {
      result.fps = Math.round((1e9 / video.defaultDuration) * 1000) / 1000;
    }
  }
  if (audio) {
    result.hasAudio = true;
    result.audioCodec = normalizeWebmCodec(audio.codecId);
  }
  if (state.durationRaw !== null) {
    result.durationSeconds = (state.durationRaw * state.timecodeScale) / 1e9;
  }
  if (result.durationSeconds && result.fps) {
    result.nbFrames = Math.round(result.durationSeconds * result.fps);
  }
  return result;
}

function normalizeWebmCodec(codecId) {
  if (!codecId) return null;
  const c = codecId.toUpperCase();
  if (c.startsWith("V_VP9")) return "vp9";
  if (c.startsWith("V_VP8")) return "vp8";
  if (c.startsWith("V_AV1")) return "av1";
  if (c.startsWith("V_MPEG4/ISO/AVC")) return "h264";
  if (c.startsWith("A_OPUS")) return "opus";
  if (c.startsWith("A_VORBIS")) return "vorbis";
  if (c.startsWith("A_AAC")) return "aac";
  if (c.startsWith("A_PCM")) return "pcm";
  return codecId;
}

/* ------------------------------------------------------------------ */
/* ISO base media / MP4                                                */
/* ------------------------------------------------------------------ */

const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "mvex"]);
const VIDEO_SAMPLE_ENTRIES = new Set(["avc1", "avc3", "hvc1", "hev1", "vp09", "av01", "mp4v"]);
const AUDIO_SAMPLE_ENTRIES = new Set(["mp4a", "ac-3", "ec-3", "Opus", "alac"]);

function* boxes(buf, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      const big = buf.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type, start: offset + headerSize, end: offset + size, boxStart: offset };
    offset += size;
  }
}

/** Recurse only into real container boxes, so leaf payloads are never misread. */
function walkBoxes(buf, start, end, onBox, depth = 0) {
  if (depth > 8) return;
  for (const box of boxes(buf, start, end)) {
    onBox(box, depth);
    if (CONTAINER_BOXES.has(box.type)) walkBoxes(buf, box.start, box.end, onBox, depth + 1);
  }
}

function readFullBoxHeader(buf, start) {
  const version = buf[start];
  const flags = (buf[start + 1] << 16) | (buf[start + 2] << 8) | buf[start + 3];
  return { version, flags, body: start + 4 };
}

function probeMp4(buf) {
  const result = {
    container: "mp4",
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    durationSeconds: null,
    nbFrames: null,
    fps: null,
    hasAudio: false,
    brands: [],
  };

  let movieTimescale = null;
  let movieDuration = null;
  const tracks = [];
  let track = null;

  walkBoxes(buf, 0, buf.length, (box) => {
    switch (box.type) {
      case "ftyp": {
        result.brands.push(buf.toString("latin1", box.start, box.start + 4).trim());
        for (let o = box.start + 4; o + 4 <= box.end; o += 4) {
          result.brands.push(buf.toString("latin1", o, o + 4).trim());
        }
        break;
      }
      case "mvhd": {
        const { version, body } = readFullBoxHeader(buf, box.start);
        if (version === 1) {
          movieTimescale = buf.readUInt32BE(body + 16);
          movieDuration = Number(buf.readBigUInt64BE(body + 20));
        } else {
          movieTimescale = buf.readUInt32BE(body + 8);
          movieDuration = buf.readUInt32BE(body + 12);
        }
        break;
      }
      case "trak": {
        track = { handler: null, width: null, height: null, codec: null, sampleCount: 0, timescale: null, duration: null };
        tracks.push(track);
        break;
      }
      case "tkhd": {
        if (!track) break;
        // width/height are the last 8 bytes of tkhd, 16.16 fixed point.
        const wOff = box.end - 8;
        if (wOff >= box.start) {
          track.width = buf.readUInt32BE(wOff) / 65536;
          track.height = buf.readUInt32BE(wOff + 4) / 65536;
        }
        break;
      }
      case "hdlr": {
        if (!track) break;
        // [version+flags u32][pre_defined u32][handler_type 4cc]
        track.handler = buf.toString("latin1", box.start + 8, box.start + 12);
        break;
      }
      case "mdhd": {
        if (!track) break;
        const { version, body } = readFullBoxHeader(buf, box.start);
        if (version === 1) {
          track.timescale = buf.readUInt32BE(body + 16);
          track.duration = Number(buf.readBigUInt64BE(body + 20));
        } else {
          track.timescale = buf.readUInt32BE(body + 8);
          track.duration = buf.readUInt32BE(body + 12);
        }
        break;
      }
      case "stsd": {
        if (!track) break;
        const count = buf.readUInt32BE(box.start + 4);
        let o = box.start + 8;
        for (let i = 0; i < count && o + 8 <= box.end; i++) {
          const entrySize = buf.readUInt32BE(o);
          const fourcc = buf.toString("latin1", o + 4, o + 8);
          if (track.codec === null) track.codec = fourcc;
          if (entrySize < 8) break;
          o += entrySize;
        }
        break;
      }
      case "stts": {
        if (!track) break;
        const entries = buf.readUInt32BE(box.start + 4);
        let o = box.start + 8;
        let samples = 0;
        for (let i = 0; i < entries && o + 8 <= box.end; i++) {
          samples += buf.readUInt32BE(o);
          o += 8;
        }
        track.sampleCount = samples;
        break;
      }
      default:
        break;
    }
  });
  const video = tracks.find((t) => t.handler === "vide");
  const audio = tracks.find((t) => t.handler === "soun");

  if (video) {
    result.videoCodec = normalizeMp4Codec(video.codec);
    result.width = video.width ? Math.round(video.width) : null;
    result.height = video.height ? Math.round(video.height) : null;
    result.nbFrames = video.sampleCount || null;
    const dur =
      video.timescale && video.duration ? video.duration / video.timescale : null;
    if (dur && result.nbFrames) result.fps = Math.round((result.nbFrames / dur) * 1000) / 1000;
  }
  if (audio) {
    result.hasAudio = true;
    result.audioCodec = normalizeMp4Codec(audio.codec);
  }
  if (movieTimescale && movieDuration !== null) {
    result.durationSeconds = movieDuration / movieTimescale;
  }
  return result;
}

function normalizeMp4Codec(fourcc) {
  if (!fourcc) return null;
  const f = fourcc.trim();
  if (f === "avc1" || f === "avc3") return "h264";
  if (f === "hvc1" || f === "hev1") return "hevc";
  if (f === "vp09") return "vp9";
  if (f === "av01") return "av1";
  if (f === "mp4a") return "aac";
  if (f === "Opus") return "opus";
  return f;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Detect the container from magic bytes.
 *
 * Returns null when the file cannot be read or is not a recognized container,
 * so a missing recording surfaces as "no media" rather than as an ENOENT stack
 * trace from deep inside the parser.
 */
export function detectContainer(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
    if (head.toString("latin1", 4, 8) === "ftyp") return "mp4";
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Probe a media file without external tools.
 *
 * Returns null when the container is unrecognized or the file cannot be read.
 * Measurement fields are null when the file is truncated rather than being
 * filled with guesses.
 */
export function probeMedia(file) {
  const container = detectContainer(file);
  if (!container) return null;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const probed = container === "webm" ? probeWebm(buf) : probeMp4(buf);
  return { ...probed, file, fileSizeBytes: buf.length };
}
