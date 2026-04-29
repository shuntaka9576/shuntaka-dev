# shuntaka.dev Design System

A design system for **shuntaka.dev** — a quiet, reading-first Japanese tech blog by **髙橋俊一 (a.k.a. shuntaka)**. The brand is built around a single visual mascot, the **matcha tea cup (ochaIcon)** 🍵, a single accent color (**magenta-pink `#e4007f`**), and a GitHub-Dark-flavored dark mode.

## Source materials

- **Source of truth** — this file (rules + voice) plus `src/app/globals.css` (token implementation).
- **Visual catalog** — `apps/web/.storybook/` (run `bun run storybook`); deployed to GitHub Pages on `main` merge.
- **Figma** (`shuntaka.dev.fig`) — early concept frames showing logo studies, share-button OGPs, MacBook Pro list view, search/tag view, and the Timeline reading-history widget. The Figma is _concept fidelity_ — the codebase is the source of truth where they conflict.

## Brand context

shuntaka.dev is the personal tech blog of a Japanese software engineer (currently at Classmethod). It hosts **tech**, **note**, and **who?** sections; articles are written in Markdown and converted server-side (Rust + comrak + syntect). The reader experience prioritises:

- **Long-form readability** over flashy chrome
- **Code blocks, link cards, and embeds** as the visual centerpiece (not photography)
- A single calm accent — magenta — used only as a brand mark or a focused state

Sister project: `blog.hozi.dev` (legacy frontend). The matcha cup mascot appears on both.

---

## Content fundamentals

The blog is **bilingual but Japanese-first**. UI labels and microcopy mix lowercase English nouns (`tech`, `note`, `who?`, `Career`, `Like`) with Japanese body text. The voice is engineer-to-engineer: factual, low-frill, often listing tech stacks without commentary.

- **Voice & person.** Third-person and impersonal (no "I"/"you"). Author bio simply lists `Career` and `Like`. No marketing copy.
- **Casing.** Tab labels are lowercase (`tech`, `note`, `who?`). Site title is lowercase too (`shuntaka.dev`). Headings within articles follow Japanese sentence case — no Title Case.
- **Punctuation.** `who?` is the only punctuated nav item — adds a touch of whimsy in an otherwise restrained interface.
- **Dates.** Always `YYYY/MM/DD` (e.g. `2021/03/12`) in Japanese locale. Article timestamps add `MM/DD HH:mm YYYY`.
- **Tags.** Hash-prefixed (`#NestJS`, `#Rust`). Tag chip shape: rounded rectangle, 1px black border, no fill.
- **Emoji.** Used **sparingly** in commit/PR titles (🍵, 🍞, 🍙, 📝) but **never** in product UI. Do not introduce emoji into the UI; the mascot already carries the warmth.
- **Numbers / stats.** None. The blog never advertises view counts, follower counts, or "trending" badges. Avoid data slop.
- **Tone samples**
  - `No articles found.` — empty state
  - `ライトモードに切り替え` / `ダークモードに切り替え` — accessible labels
  - `Posted on blog.hozi.dev/ 1 days ago` — timeline records
  - `Career` `201204 TDU EC` `201604 株式会社QUICK` — bio entries (date-prefixed, terse)
- **Don't.** No "Welcome!" headers, no "Subscribe to my newsletter" CTAs, no emoji buttons, no exclamation marks in prose.

---

## Visual foundations

### Color

- **Light:** off-white `#f7fafc` page on `#ffffff` surfaces; nearly-white `#fffefc` for the header. Body text `#525457` — a warm dark grey, **not** pure black.
- **Dark:** GitHub-Dark navy. `#22272e` page, `#2d333b` raised, body `#c9d5e1`.
- **Accent:** **`#e4007f`** magenta-pink. Used for: the dark-mode toggle ON track, the NProgress bar, focus-visible outline, and the danger callout border. **Never** for body text, **never** as a fill on cards.
- **Borders:** `#c4c4c4` for general; `rgba(162,177,202,0.3)` for the article-list under-line — almost invisible, just a typographic baseline.

### Typography

- **English:** Roboto (400/700) — loaded via `next/font/google`, exposed as `--font-roboto`.
- **Japanese:** Noto Sans JP — exposed as `--font-noto-sans-jp`. (Figma drafts use Hiragino Sans; the production build uses Noto Sans JP because Hiragino is macOS-only.)
- **Mono:** system stack (`ui-monospace, SFMono-Regular, …`).
- **Scale (rem-based, 1rem = 16px).** `display 32 / h1 27 / h2 24 / h3 20 / h4 18 / body-lg 16 / body 15 / caption 13 / code 14`.
- **Line-height.** Body `1.9` (generous — reading ergonomics). Headings `1.4`. Lists `1.7`.
- **No `em`/`px` mixing.** Type uses `rem`; layout uses `px` or layout tokens.
- **`<strong>` is the only emphasis.** No colored emphasis, no all-caps, no letter-spacing tweaks.

### Backgrounds

- **No imagery.** No hero photos, no full-bleed gradients, no patterns, no grain. Surfaces are flat `#fff` (light) or flat navy (dark).
- **No gradients** anywhere. The system explicitly rejects "rainbow gradients, neon shadows".
- **Article wrapper** is a flat `#fff` panel with `15px` corner radius, `1px` subtle border.

### Borders & corners

- **Radii: 4 levels.** `4px` (buttons, tags), `10px` (cards, thumbnails), `15px` (article wrapper), `9999px` (toggle, circular icons).
- **Borders are 1px solid.** Color usually `--color-border` or its `subtle` sibling. No double borders, no dashed.

### Shadows / elevation

- The production CSS uses **one** real shadow: `0 2px 8px rgba(0,0,0,0.10)` on `link-card:hover`.
- A 4-step elevation token set is reserved (`--shadow-0`…`--shadow-3`) for future modals/popovers but is currently unused.
- **Don't** add drop shadows to cards at rest. The system reads as flat-by-default.

### Motion

- **Tokens:** `--motion-fast 150ms / --motion-base 250ms / --motion-slow 400ms`. Easing is browser-default (linear / ease).
- **Used for:** copy-button opacity (`0.4 → 1.0`), link-card border-color & shadow, NProgress bar.
- **No bounces, no spring, no entrance animations** on page load. The blog is meant to feel "instant".

### Hover / press / focus

- **Hover.** Change _one_ property by one step — usually `filter: brightness(95%)` for buttons, or a border-color swap for link cards.
- **Focus-visible.** Universal `outline: 2px solid var(--color-accent); outline-offset: 2px;` — applied to every `a`, `button`, `[role="button"]`, input, summary in `globals.css`. Critical accessibility primitive.
- **Active.** `filter: brightness(90%)` for buttons.
- **Disabled.** `opacity: 0.5; pointer-events: none;` + `aria-disabled="true"`.

### Layout rules

- Single `--layout-max: 1200px` outer column, centered. Article list inside is capped to `--layout-list-max: 600px`.
- Article page = `flex justify-between` of a left content column + `296px` sticky right TOC sidebar; sidebar collapses below `lg`.
- Sticky TOC offset is computed: `top: calc(var(--layout-header-h) + var(--layout-nav-h) + var(--space-5))` — never magic numbers.
- Footer is `position: absolute; bottom: 0;` with reserved `58px` of bottom padding on the body. Header is **not** sticky.
- **No `display: grid`** in the codebase today. Multi-column layouts use Flex + `gap`.

### Transparency & blur

- **None.** No `backdrop-filter`, no glassmorphism, no semi-transparent overlays. The TOC's `is-active` track uses an opacity-based color (`#57595b87`) but that's it.

### Imagery vibe

- Article thumbnails are user-supplied OGP images, treated as content. Container: `150×100`, `object-cover`, `10px` radius, `loading="lazy"`. No filters, no tints, no overlays.

### What this system rejects

- Rainbow / blue-purple gradients
- Neon shadows
- Emoji-laden UI
- Cards with rounded corners + colored left-border accent
- Tailwind preset palette (`bg-blue-500`, `text-red-500`) — banned in favour of CSS variables
- Hardcoded inline `style={{ color: '#…' }}` — banned

---

## Iconography

**Approach.** A small, hand-curated set of single-color SVGs sits in `public/assets/`. There is **no icon font** and **no icon library** (no Lucide, no Heroicons). When new icons are needed, copy the existing ones in style: a single fill or stroke, no gradients, no multi-color glyphs.

### Mascot — `ochaIcon` 🍵

A friendly matcha cup with a smile. It's the brand mark; it appears as the favicon, the timeline-record bullet, the logo on the marketing concept, and the social-link "homepage" icon. **Always full-color** (matcha green body `#6e9050`, foam `#bde030`, blush cheeks `#fff9f9`). Do not invert it, do not recolor it.

### Social-link glyphs

Single-color brand marks (`#525457` in light, `#c9d5e1` in dark via container `color: inherit`). All sized to a `24×24` box.

| File                         | Service                                   |
| ---------------------------- | ----------------------------------------- |
| `public/assets/github.svg`   | GitHub (`shuntaka9576`)                   |
| `public/assets/x.svg`        | X / Twitter (`shuntaka_dev`)              |
| `public/assets/zenn.svg`     | Zenn (`shuntaka`)                         |
| `public/assets/sd.svg`       | SpeakerDeck                               |
| `public/assets/devio.svg`    | DevelopersIO (Classmethod author profile) |
| `public/assets/bluesky.svg`  | Bluesky                                   |
| `public/assets/ochaIcon.svg` | the personal site itself                  |

### Functional glyphs

Inlined SVG paths, not imported as files:

- **Toggle moon/sun** (in `ToggleSwitch.tsx`) — moon `circle` + sun `path` SVG, paired with a sliding pill knob.
- **Copy button** (in `globals.css` + `ArticleContent.tsx` injected DOM) — clipboard glyph.
- **GitHub-embed copy / check** — same family as the copy button.

### `404.svg`

A custom illustrated `404` mark used on the 404 page (and once in the Figma marketing frame).

### Emoji & unicode

- **Not used in product UI.** The `who?` page punctuation is the only typographic flourish.
- Used only in commit messages / repo READMEs (🍵 🍞 🍙 ✨ 📝).

### Substitutions

None — the production icon set is small enough to use entirely. If you need a glyph not in `public/assets/`, prefer **Lucide** (matching stroke style: 1.5px, no fill) and flag the substitution in the PR description.

---

## CAVEATS

- **Fonts.** Production uses `next/font` for Roboto + Noto Sans JP, exposed as `--font-roboto` and `--font-noto-sans-jp`. No CDN dependency; `next/font` self-hosts subsets at build time.
- **Hiragino Sans (Figma) → Noto Sans JP (production).** The Figma file lists Hiragino Sans because it's the macOS default; we use Noto Sans JP everywhere because it ships everywhere. Treat the two as visually equivalent.
- **Dark mode.** Tokens are wired up via `[data-theme='dark']` on `<html>`, toggled by `ToggleSwitch`. The `prefers-color-scheme: dark` media query is also honored when no explicit theme is saved.

---

## Implementation pointers

- **Token implementation.** All design tokens (colors, spacing, radius, line-height, type scale, motion, shadows) live in `src/app/globals.css`. Light values are in `:root`, dark overrides in `[data-theme='dark']` and the `prefers-color-scheme: dark` block.
- **Visual catalog.** `apps/web/.storybook/` hosts Storybook (Storybook 10 + `@storybook/nextjs-vite`). Stories cover real production components and token swatches.
  - Run locally: `bun run storybook` (`http://localhost:6006`)
  - Static build: `bun run build-storybook` → `apps/web/storybook-static/`
  - Deploy: pushes to `main` trigger `.github/workflows/deploy-storybook.yaml`, which publishes to GitHub Pages with `STORYBOOK_BASE_PATH=/<repo>/`.
- **Components.** `src/components/*.tsx` is the canonical UI. When introducing a new visual element, prefer extending an existing component or adding a new Story over hand-rolling raw HTML.
