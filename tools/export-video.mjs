#!/usr/bin/env node
// Export an animation page to MP4 with ffmpeg, optionally with narration.
//
// The page is opened in headless Chromium with the #export hash, which hides
// the captions and controls and shows only the 16:9 stage. The GSAP timeline is
// then stepped one frame at a time (no real-time playback), so every frame is
// exact and the output never drops or stutters, however slow the machine.
//
// Narration (--narrate) is synthesized per scene with Piper (pip install piper-tts)
// from each scene's spoken text. The voice drives the timing: when a scene's line
// runs longer than the scene, the scene's last frame is held until the line ends,
// so the voice is never sped up or cut off.
//
// Usage:
//   npm run export:video
//   npm run export:video -- --narrate --voice voices/en_US-lessac-medium.onnx
//   node tools/export-video.mjs [--page y1-payment-repair.html] [--out exports/y1-payment-repair.mp4]
//                               [--fps 30] [--width 1920] [--height 1080] [--ffmpeg /path/to/ffmpeg]
//                               [--audio narration.mp3 | --narrate --voice model.onnx [--piper piper]]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);

const { values: opts } = parseArgs({
  options: {
    page: { type: "string", default: "y1-payment-repair.html" },
    out: { type: "string" },
    fps: { type: "string", default: "30" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    audio: { type: "string" },
    narrate: { type: "boolean", default: false },
    voice: { type: "string", default: "voices/en_US-lessac-medium.onnx" },
    piper: { type: "string", default: "piper" },
    ffmpeg: { type: "string" },
  },
});

// Narration placement within each scene, in seconds.
const LEAD = 0.4; // silence before the line starts
const TAIL = 0.8; // silence after the line before the scene ends

const page = resolve(opts.page);
const name = basename(page, extname(page));
const out = resolve(opts.out ?? `exports/${name}.mp4`);
const fps = Number(opts.fps);
const width = Number(opts.width);
const height = Number(opts.height);
if (!existsSync(page)) fail(`Page not found: ${page}`);
if (!(fps > 0) || !(width > 0) || !(height > 0)) fail("--fps, --width and --height must be positive numbers.");
if (opts.audio && opts.narrate) fail("Use either --audio or --narrate, not both.");
if (opts.audio && !existsSync(opts.audio)) fail(`Audio file not found: ${opts.audio}`);
if (opts.narrate && !existsSync(opts.voice)) {
  fail(
    `Voice model not found: ${opts.voice}\n` +
      "  Download a Piper voice (.onnx plus its .onnx.json) from https://huggingface.co/rhasspy/piper-voices\n" +
      "  into voices/, or pass --voice <path-to-model.onnx>.",
  );
}

// Prefer an explicit path, then the ffmpeg-static binary, then ffmpeg on PATH.
function ffmpegPath() {
  if (opts.ffmpeg) return opts.ffmpeg;
  try {
    const p = require("ffmpeg-static");
    if (p && existsSync(p)) return p;
  } catch {}
  return "ffmpeg";
}

// Serve GSAP from node_modules when it is installed, so export works offline.
function localGsap() {
  try {
    return require.resolve("gsap/dist/gsap.min.js");
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`export-video: ${msg}`);
  process.exit(1);
}

function run(cmd, args, input) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => rej(new Error(`could not run ${cmd} (${e.message})`)));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited with code ${code}: ${err.trim().slice(-400)}`))));
    p.stdin.end(input);
  });
}

// Duration of a PCM WAV file, from its header.
function wavDuration(file) {
  const b = readFileSync(file);
  const byteRate = b.readUInt32LE(28);
  for (let i = 12; i + 8 <= b.length; ) {
    const id = b.toString("ascii", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === "data") return Math.min(size, b.length - i - 8) / byteRate;
    i += 8 + size + (size % 2);
  }
  throw new Error(`no audio data in ${file}`);
}

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));

const gsapFile = localGsap();
if (gsapFile) {
  await tab.route(/\/gsap(\.min)?\.js(\?.*)?$/, (route) =>
    route.fulfill({ path: gsapFile, contentType: "text/javascript" }),
  );
}

await tab.goto(`${pathToFileURL(page).href}#export`);
try {
  await tab.waitForFunction(() => window.__exporter, null, { timeout: 30_000 });
} catch {
  await browser.close();
  fail(
    "The page did not start in export mode. Check that GSAP can load (run `npm install` to use the local copy)" +
      (errors.length ? ` and fix: ${errors.join("; ")}` : "."),
  );
}
// Fonts may come from Google Fonts; give them a few seconds, then carry on with the fallback faces.
await tab.evaluate(() => Promise.race([window.__exporter.ready, new Promise((r) => setTimeout(r, 5000))]));

const { duration: animDuration, fade, scenes } = await tab.evaluate(() => {
  const { duration, fade, scenes } = window.__exporter;
  return { duration, fade, scenes };
});

// Video timeline. Without narration it is the animation's own timeline. With narration,
// each scene lasts at least as long as LEAD + its line + TAIL; any extra time is spent
// holding the scene's last frame just before it fades out.
let duration = animDuration;
let animTime = (t) => t;
let clips = [];
if (opts.narrate) {
  const dir = resolve(`exports/narration/${name}`);
  mkdirSync(dir, { recursive: true });
  console.log(`Synthesizing narration with ${basename(opts.voice)}`);
  for (const [i, s] of scenes.entries()) {
    const file = join(dir, `scene${i + 1}.wav`);
    try {
      await run(opts.piper, ["-m", resolve(opts.voice), "-f", file, "--sentence-silence", "0.25"], s.say);
    } catch (e) {
      await browser.close();
      fail(`${e.message}\n  Install Piper with \`pip install piper-tts\`, or pass --piper <path-to-piper>.`);
    }
    clips.push({ file, length: wavDuration(file) });
  }
  let videoStart = 0;
  const plan = scenes.map((s, i) => {
    const length = s.end - s.start;
    const videoLength = Math.max(length, LEAD + clips[i].length + TAIL);
    const p = { ...s, length, hold: videoLength - length, videoStart, videoLength };
    videoStart += videoLength;
    return p;
  });
  duration = videoStart;
  animTime = (t) => {
    const s = plan.find((p) => t < p.videoStart + p.videoLength) ?? plan[plan.length - 1];
    const u = t - s.videoStart;
    const holdAt = s.length - fade; // last fully visible moment before the fade-out
    if (u < holdAt) return s.start + u;
    if (u < holdAt + s.hold) return s.start + holdAt - 1e-3;
    return s.start + u - s.hold;
  };
  clips = clips.map((c, i) => ({ ...c, at: plan[i].videoStart + LEAD }));
  for (const [i, p] of plan.entries()) {
    console.log(
      `  scene ${i + 1}: line ${clips[i].length.toFixed(1)}s, scene ${p.videoLength.toFixed(1)}s` +
        (p.hold >= 0.05 ? ` (holds ${p.hold.toFixed(1)}s)` : ""),
    );
  }
}

const frames = Math.round(duration * fps);
mkdirSync(dirname(out), { recursive: true });
const args = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
if (opts.audio) {
  args.push("-i", resolve(opts.audio), "-map", "0:v", "-map", "1:a");
} else if (clips.length) {
  for (const c of clips) args.push("-i", c.file);
  const delayed = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`);
  const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0,apad[aout]`;
  args.push("-filter_complex", [...delayed, mix].join(";"), "-map", "0:v", "-map", "[aout]");
}
if (opts.audio || clips.length) args.push("-c:a", "aac", "-b:a", "192k");
args.push(
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", "-t", duration.toFixed(3), out,
);

const ffmpeg = spawn(ffmpegPath(), args, { stdio: ["pipe", "inherit", "inherit"] });
const ffmpegDone = new Promise((res, rej) => {
  ffmpeg.on("error", (e) =>
    rej(new Error(`could not start ffmpeg (${e.message}). Install ffmpeg or pass --ffmpeg <path>.`)),
  );
  ffmpeg.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with code ${code}.`))));
});
ffmpegDone.catch(() => {}); // reported below

console.log(`Rendering ${frames} frames (${duration.toFixed(1)}s at ${fps} fps, ${width}x${height}) to ${out}`);
const started = Date.now();
try {
  for (let i = 0; i < frames; i++) {
    await tab.evaluate((t) => window.__exporter.renderAt(t), animTime(i / fps));
    const png = await tab.screenshot({ type: "png" });
    if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % fps === 0 || i === frames - 1) {
      process.stdout.write(`\r  ${Math.round(((i + 1) / frames) * 100)}%  frame ${i + 1}/${frames}`);
    }
  }
  ffmpeg.stdin.end();
  await ffmpegDone;
} catch (e) {
  ffmpeg.kill();
  await browser.close();
  fail(e.message);
}
await browser.close();

console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s: ${out}`);
if (errors.length) console.warn(`Page errors during export: ${errors.join("; ")}`);
