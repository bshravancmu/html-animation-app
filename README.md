# html-animation-app

A plain HTML/JS animation playground using [GSAP](https://gsap.com).

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
