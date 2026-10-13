# html-animation-app

A plain HTML/JS animation playground using [GSAP](https://gsap.com).

## Animations

- [`y1-payment-repair.html`](y1-payment-repair.html): *Payment repair, rebuilt*, a 60-second, five-scene GSAP timeline for use case Y1 (payment validation and repair). It follows `BNY-Ops-Y1-Payment-Repair-Audio-Script.md` from the `cmu-csl-future-of-workforce` repo. It shows the narration as captions and has play/pause, scene buttons and a scrubber, plus optional read-aloud using the browser's speech synthesis. It does not autoplay for viewers who have turned on reduced motion.

### Export to video

`tools/export-video.mjs` renders an animation page to MP4. It opens the page in headless Chromium in export mode (`#export`), which shows only the 16:9 stage without the captions, controls or sources. It then steps the GSAP timeline one frame at a time and pipes the frames into ffmpeg. Every frame is exact, so the video never stutters, however slow the machine.

```sh
npm install
npx playwright install chromium   # first time only
npm run export:video              # writes exports/y1-payment-repair.mp4 (1920x1080, 30 fps, H.264)
```

Options: `--page <file.html>`, `--out <file.mp4>`, `--fps 60`, `--width 3840 --height 2160` (the stage is vector, so 4K stays sharp), and `--ffmpeg <path>`. The script looks for ffmpeg in this order: `--ffmpeg`, the `ffmpeg-static` package (installed automatically on Windows, macOS and Linux), then `ffmpeg` on your PATH. A full 60-second export takes about two to three minutes.

### Narration

`--narrate` generates a voiceover from each scene's narration with [Piper](https://github.com/rhasspy/piper), a free text-to-speech engine that runs offline, and mixes it into the video:

```sh
pip install piper-tts
# Download a voice: both en_US-lessac-medium.onnx and en_US-lessac-medium.onnx.json from
# https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium into voices/
npm run export:video -- --narrate
```

The voice drives the timing. Each line starts 0.4 s into its scene. When a line runs longer than its scene, the scene's last frame is held until the line ends, so the voice is never sped up or cut off. The 60-second animation becomes a video of about 65 seconds. Use `--voice <model.onnx>` for another voice and `--piper <path>` if `piper` isn't on your PATH. Check a voice's licence in its model card before using it outside the study.

To use a recorded voiceover instead, pass `--audio narration.mp3`.

### Logo

The stage shows the BNY wordmark top-left in white: "BNY" set in Inter ExtraBold with wide letter spacing. To use the official logo file instead, save it as `assets/bny-logo.png`. The page draws it in white and hides the text version. The file needs a transparent background.

## Agent skills

The official GSAP agent skills live in `.claude/skills/`, so Claude Code picks them up automatically in this repo:

| Skill | Covers |
| --- | --- |
| `gsap-core` | `gsap.to/from/fromTo`, easing, stagger, `matchMedia` |
| `gsap-timeline` | Sequencing with timelines |
| `gsap-scrolltrigger` | Scroll-driven animation |
| `gsap-plugins` | Flip, Draggable, SplitText, MorphSVG, etc. |
| `gsap-utils` | `gsap.utils` helpers |
| `gsap-react` | `useGSAP` and React patterns |
| `gsap-frameworks` | Vue, Svelte and other frameworks |
| `gsap-performance` | Performance best practices |

See `.claude/skills/SOURCE.md` for the upstream commit.

## Run

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```
