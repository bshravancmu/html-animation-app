#!/usr/bin/env node
// Export an animation page to MP4 with ffmpeg.
//
// The page is opened in headless Chromium with the #export hash, which hides
// the captions and controls and shows only the 16:9 stage. The GSAP timeline is
// then stepped one frame at a time (no real-time playback), so every frame is
// exact and the output never drops or stutters, however slow the machine.
//
// Usage:
//   npm run export:video
//   node tools/export-video.mjs [--page y1-payment-repair.html] [--out exports/y1-payment-repair.mp4]
//                               [--fps 30] [--width 1920] [--height 1080]
//                               [--audio narration.mp3] [--ffmpeg /path/to/ffmpeg]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, resolve } from "node:path";
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
    ffmpeg: { type: "string" },
  },
});

const page = resolve(opts.page);
const out = resolve(opts.out ?? `exports/${basename(page, extname(page))}.mp4`);
const fps = Number(opts.fps);
const width = Number(opts.width);
const height = Number(opts.height);
if (!existsSync(page)) fail(`Page not found: ${page}`);
if (opts.audio && !existsSync(opts.audio)) fail(`Audio file not found: ${opts.audio}`);
if (!(fps > 0) || !(width > 0) || !(height > 0)) fail("--fps, --width and --height must be positive numbers.");

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

const duration = await tab.evaluate(() => window.__exporter.duration);
const frames = Math.round(duration * fps);

mkdirSync(dirname(out), { recursive: true });
const args = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
if (opts.audio) args.push("-i", resolve(opts.audio), "-c:a", "aac", "-b:a", "192k");
args.push(
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", "-t", String(duration), out,
);

const ffmpeg = spawn(ffmpegPath(), args, { stdio: ["pipe", "inherit", "inherit"] });
const ffmpegDone = new Promise((res, rej) => {
  ffmpeg.on("error", (e) =>
    rej(new Error(`could not start ffmpeg (${e.message}). Install ffmpeg or pass --ffmpeg <path>.`)),
  );
  ffmpeg.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with code ${code}.`))));
});
ffmpegDone.catch(() => {}); // reported below

console.log(`Rendering ${frames} frames (${duration}s at ${fps} fps, ${width}x${height}) to ${out}`);
const started = Date.now();
try {
  for (let i = 0; i < frames; i++) {
    await tab.evaluate((t) => window.__exporter.renderAt(t), i / fps);
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
