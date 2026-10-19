/**
 * The validator must be able to describe a recording even on a machine without
 * system FFprobe, so the skill carries its own container parser. A parser that
 * quietly disagreed with FFprobe would make every "validated" claim worthless,
 * so these tests compare the two on real encoded files, and check the parser
 * refuses to invent facts about files it cannot understand.
 *
 * Test media is encoded with the system FFmpeg (libx264 for MP4, libvpx-vp9 for
 * WebM). Playwright's bundled FFmpeg is not used here because it is built with
 * almost everything disabled and cannot synthesise input.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectContainer, probeMedia } from "../scripts/media-probe.mjs";
import { loadFfmpegInfo, tmpDir } from "./helpers.mjs";

const MAGIC_WEBM = "1a45dfa3";

async function run(bin, args, timeout = 120000) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Encode a 2 s 640x480 test video, in `codec` (vp9 or h264). */
async function makeVideo(ffmpegPath, dir, codec) {
  const isWebm = codec === "vp9";
  const file = path.join(dir, isWebm ? "sample.webm" : "sample.mp4");
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x480:rate=30:duration=2",
    "-c:v", isWebm ? "libvpx-vp9" : "libx264",
    "-b:v", isWebm ? "200k" : "400k",
  ];
  if (!isWebm) args.push("-pix_fmt", "yuv420p", "-an");
  args.push("-y", file);
  const { code, out } = await run(ffmpegPath, args);
  if (code !== 0 || !fs.existsSync(file)) return null;
  return file;
}

test("container detection is based on real file signatures", async (t) => {
  const { ffmpeg } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is not installed, so no test media can be produced");

  const dir = tmpDir("probe-detect");
  const webm = await makeVideo(ffmpeg, dir, "vp9");
  assert.ok(webm, "could not encode a WebM with libvpx-vp9");

  const magic = fs.readFileSync(webm).subarray(0, 4).toString("hex");
  assert.equal(magic, MAGIC_WEBM, "a WebM file must start with the EBML magic");
  assert.equal(detectContainer(webm), "webm");

  const mp4 = await makeVideo(ffmpeg, dir, "h264");
  assert.ok(mp4, "could not encode an MP4 with libx264");
  assert.equal(detectContainer(mp4), "mp4");

  const unknown = path.join(dir, "not-video.bin");
  fs.writeFileSync(unknown, "this is definitely not a video");
  assert.equal(detectContainer(unknown), null);

  assert.equal(detectContainer(path.join(dir, "missing.mp4")), null, "a missing file is not a container");
});

test("the parser reports the same facts as FFprobe for a real WebM", async (t) => {
  const { ffmpeg, ffprobe } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is not installed");

  const dir = tmpDir("probe-webm");
  const file = await makeVideo(ffmpeg, dir, "vp9");
  assert.ok(file, "could not encode a WebM");

  const own = probeMedia(file);
  assert.ok(own, "the parser must recognise a real WebM");
  assert.equal(own.container, "webm");
  assert.equal(own.videoCodec, "vp9");
  assert.equal(own.width, 640);
  assert.equal(own.height, 480);
  assert.equal(own.fps, 30);
  assert.equal(own.hasAudio, false, "a video-only file must not claim audio");
  assert.ok(own.durationSeconds > 1.8 && own.durationSeconds < 2.3, `duration ${own.durationSeconds} should be ~2s`);
  assert.ok(own.nbFrames >= 55, `expected ~60 frames, got ${own.nbFrames}`);

  if (!ffprobe) return; // on a machine without FFprobe the parser stands alone
  const ext = await run(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json", file,
  ]);
  assert.equal(ext.code, 0, ext.out);
  const parsed = JSON.parse(ext.out);
  const stream = parsed.streams[0];
  assert.equal(own.videoCodec, stream.codec_name, "codec must match ffprobe");
  assert.equal(own.width, stream.width, "width must match ffprobe");
  assert.equal(own.height, stream.height, "height must match ffprobe");
  const [num, den] = String(stream.avg_frame_rate).split("/").map(Number);
  assert.equal(own.fps, Math.round(num / den), "frame rate must match ffprobe");
  assert.ok(
    Math.abs(own.durationSeconds - Number(parsed.format.duration)) < 0.15,
    `duration ${own.durationSeconds} should agree with ffprobe's ${parsed.format.duration}`
  );
});

test("the parser reports the same facts as FFprobe for a real H.264 MP4", async (t) => {
  const { ffmpeg, ffprobe } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is not installed, so no H.264 file can be produced");

  const dir = tmpDir("probe-mp4");
  const file = await makeVideo(ffmpeg, dir, "h264");
  assert.ok(file, "could not encode an H.264 MP4");

  const own = probeMedia(file);
  assert.ok(own);
  assert.equal(own.container, "mp4");
  assert.equal(own.videoCodec, "h264");
  assert.equal(own.width, 640);
  assert.equal(own.height, 480);
  assert.equal(own.fps, 30);
  assert.equal(own.hasAudio, false);
  assert.ok(own.durationSeconds > 1.8 && own.durationSeconds < 2.3, `duration ${own.durationSeconds}`);

  if (!ffprobe) return;
  const ext = await run(ffprobe, [
    "-v", "error",
    "-show_entries", "stream=codec_name,codec_type,width,height",
    "-show_entries", "format=duration",
    "-of", "json", file,
  ]);
  assert.equal(ext.code, 0, ext.out);
  const parsed = JSON.parse(ext.out);
  const video = parsed.streams.find((s) => s.codec_type === "video");
  assert.equal(own.videoCodec, video.codec_name);
  assert.equal(own.width, video.width);
  assert.equal(own.height, video.height);
  assert.ok(Math.abs(own.durationSeconds - Number(parsed.format.duration)) < 0.2);
});

test("audio is detected when a file really has an audio track", async (t) => {
  const { ffmpeg, ffprobe } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is not installed");

  const dir = tmpDir("probe-audio");
  const file = path.join(dir, "with-audio.mp4");
  const { code, out } = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", file,
  ]);
  assert.equal(code, 0, out);

  const own = probeMedia(file);
  assert.ok(own);
  assert.equal(own.hasAudio, true, "an audio track must be reported, so a stray track cannot hide");
  assert.ok(own.audioCodec, "the audio codec should be named, not just flagged");

  if (!ffprobe) return;
  const ext = await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file]);
  const hasAudio = JSON.parse(ext.out).streams.some((s) => s.codec_type === "audio");
  assert.equal(own.hasAudio, hasAudio);
});

test("an unrecognised file is reported as unknown rather than guessed at", async () => {
  const dir = tmpDir("probe-garbage");
  const random = path.join(dir, "random.bin");
  fs.writeFileSync(random, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
  assert.equal(probeMedia(random), null, "an unknown container must not produce a media description");

  const empty = path.join(dir, "empty.bin");
  fs.writeFileSync(empty, "");
  assert.equal(probeMedia(empty), null);
});

test("a truncated file yields no measurements, so it cannot pass as a valid video", async () => {
  const dir = tmpDir("probe-truncated");
  const truncated = path.join(dir, "truncated.webm");
  fs.writeFileSync(truncated, Buffer.from(`${MAGIC_WEBM}ffffffffffffffffff`, "hex"));

  const probed = probeMedia(truncated);
  assert.ok(probed, "the container magic is present, so the container is identified");
  assert.equal(probed.container, "webm");
  // …but nothing may be invented about its contents.
  assert.equal(probed.width, null);
  assert.equal(probed.height, null);
  assert.equal(probed.durationSeconds, null);
  assert.equal(probed.videoCodec, null);
});
