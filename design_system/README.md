# opencoo — Design System

A design system for **opencoo**: a self-hosted system that ingests a company's documents, transcripts, and project state; compiles them into an LLM-maintained markdown wiki in Gitea; serves that wiki to employees' AI agents via MCP; and runs a self-operating advisory layer on top. Name is always lowercase, one word.

It is **partner-delivered, not SaaS** — target customers are 20–200-employee companies who get a single-tenant deployment. Open source under Apache-2.0.

The product is modular around two engines: **Ingestion** (reads the world, writes the wiki) and **Self-Operating** (reads the wiki, writes to the world). First-party agents: Heartbeat, Lint, Chat, Surfacer, Builder. Default output surfaces are the Management UI, the Review Dashboard, and a terminal CLI.

## Sources used to build this system

- **Identity & system reference:** `source/design-system.html` — the canonical visual/identity spec this system is distilled from.
- **Logo motion:** `source/logo-animation.html` — the "draw → open → compile → operate → heartbeat" intro loop.
- **Architecture doc:** `source/architecture.md` — product, surfaces, and terminology.

The reader of this README is not assumed to have access to any of the above; everything needed to design for opencoo lives in this folder.

---

## Index

| Path | What's in it |
|---|---|
| `README.md` | This file — brand, voice, visual, iconography reference |
| `SKILL.md` | Agent-Skill manifest — drop this folder into a Claude Code skill |
| `colors_and_type.css` | CSS variables for color, type, spacing, radii, easing |
| `fonts/` | Webfont references (Geist, JetBrains Mono, Instrument Serif — Google Fonts) |
| `assets/` | Logos, glyphs, app icon, extracted SVGs |
| `preview/` | Small cards that populate the Design System review tab |
| `ui_kits/management-console/` | UI kit for the Management Console (React/JSX) |
| `source/` | Originals provided by the user — read-only reference |

---

## Content fundamentals

opencoo writes the way its engine works: **compiled, not expanded**. Copy is technical, literal, and short.

**Tone.** Dry, honest, technical. Never marketing-flavored. The product makes claims it can back with primitives (no vector store, no RAG, no cloud tenancy by default) — so the voice is confident but concrete, not hypey.

**Voice rules.**
- Product name is always lowercase: **opencoo**. Never "OpenCoo" or "Open Coo" or "OpenCOO".
- Prefer short, declarative sentences. One thought per sentence.
- Second person ("your company's second brain") on marketing surfaces; first-person plural ("we ship n8n-mcp only") in engineering prose.
- Technical nouns beat marketing verbs — "compiled," "ingestion," "orbit," "domain," "binding," "review mode."
- Lowercase UI labels in mono chrome (`source type`, `target domain`). Title-Case only for human content (document titles, page names).
- No emoji. Ever. No 🚀 🎉 💡 / no celebratory punctuation.
- No "AI-powered", "unlock", "revolutionary", "seamless", "intelligent." If it needs an adjective to sell it, rewrite.
- `I` vs `you`: agents use first-person when quoting themselves (`"two contradictions remain"`); system chrome is neutral third-person.

**Shibboleths — phrases to reach for.**
> "Compiled at ingestion, not retrieved at query time."
> "Agents navigate by path."
> "The wiki is the product."
> "One process by default. Split when you need to."
> "Your company's *compiled* & *self-operating* second brain."

**Anti-patterns — the exact opposite of opencoo's voice.**
> ~~"Revolutionary AI-powered enterprise knowledge platform."~~
> ~~"Unlock insights from your data with semantic search."~~
> ~~"OpenCoo · OpenCOO · Open Coo."~~

**Casing.** `opencoo` in running prose. `OPENCOO` never. Product surface labels in micro-mono-uppercase (`REVIEW · APPROVE · LINT`). File paths in lowercase with hyphens: `wiki-executive/processes/pricing-2026q2.md`.

---

## Visual foundations

### Overall vibe

opencoo looks like **printed documentation** — a technical manual, a blueprint, an architecture diagram drawn in ink on warm paper. Not a SaaS landing page. Not a glass UI. The design language is quietly confident: hairlines, mono captions, tight radii, no shadows.

### Color

- **Base is paper + ink** — a warm-neutral five-step scale from `#F6F3EC` (paper) down to `#121210` (ink). The warmth is deliberate — cool-gray reads as "enterprise SaaS" and we actively avoid that.
- **One hero accent** — **Advisory Amber** (`oklch(0.74 0.13 70)`), reserved for the *agent layer*: Heartbeat cards, approval prompts, the CLI trio in output, advisory CTAs. Coverage budget: under 10% per screen.
- **One supporting accent** — **Wiki Teal** (`oklch(0.55 0.08 180)`), used only for compiled-knowledge chrome: citation pills, wiki-path badges, the "wiki" badge.
- **Alert Red** is strictly for destructive/flagged items (guard flags, contradictions). Never amber for destructive — that's the agent's color.
- **Never:** purple, blue-gray enterprise palette, gradients on the mark, white cards on white backgrounds.

### Type

Three families, one job each.

- **Instrument Serif** (italic) — display only. Brand taglines, section ledes. Never body. **Inside the management console, the ONLY legal call site is `<Display>` (`packages/ui/src/components/Display.tsx`, wave-16 PR-C4).** An ESLint local rule (`packages/ui/eslint.local.js`) fails any other inline reference to `var(--font-serif)` / `t-lede` / `Instrument Serif`. Three strategic placements ship today: Reports heartbeat lede, Prompts empty-state lede, Domains tab top-line summary. `<Display level={1}>` is reserved for a future docs site; the UI uses level=2 + level=3 only.
- **Geist** — everything UI: H1/H2/H3, body, card titles, buttons.
- **JetBrains Mono** — paths, IDs, data, logs, micro labels (`REVIEW · APPROVE · REJECT`), button shortcuts (`⌘H`), the `?` tooltip-trigger character (PR-C1).

Sizes are in `colors_and_type.css`. The `--tr-*` tokens encode tracking — negative on display/headings, positive on micro-caps.

#### In-app help (`help.<term>` namespace)

Per-jargon-term explanations live under the `help.<term>.{label,body}` i18n namespace. Each term renders via the `<Tooltip>` primitive (`packages/ui/src/components/Tooltip.tsx`, wave-16 PR-C1): a `<button>` with a JetBrains Mono `?` micro character, focus-keyboard reachable, ARIA-described, collision-positioned via `@floating-ui/react`. The glyph trio (RingWithDot / FilledDisc / OpenArc) is reserved for product-concept iconography; UI affordances use type. The PR-C1 baseline ships `reviewMode` / `allowedPaths` / `scopeDomainIds` / `worldviewEnabled` / `governanceCadence`. Adding a new term: write `help.<term>.label` (short noun phrase) + `help.<term>.body` (1-2 sentences explaining meaning + consequence-of-change) in `en.json`, mirror in `pl.json` (the `tools/i18n-check.ts` fence catches missing pl entries), then `<Tooltip term="<term>">` next to the form label or `<TooltipTrigger term="<term>" />` standalone.

### Backgrounds

- **Paper canvas.** `#F6F3EC`. Full-bleed on most pages.
- **Optional blueprint grid.** A 48px × 48px hairline grid at 5% ink can layer behind hero areas on brand pages. Used sparingly — it's a texture, not wallpaper.
- **No photography as hero background.** opencoo is self-hosted software; imagery slots are for screenshots of the product, diagrams, or the animated wordmark.
- **No gradients.** On anything. Ever.

### Animation

- **Ease:** `cubic-bezier(.55,.1,.2,1)` for write-on / entry, `cubic-bezier(.6,.05,.2,1)` for transformations.
- **Signature motion:** the logo **writes itself on** letter by letter, then the `c` rotates 180° to open, the middle `o` ink-floods to compile, the last `o` gets a center dot to operate. Intro runs 3.2s, then a **heartbeat pulse** (1.6s cycle, outer ring of operate glyph only) runs forever.
- **The heartbeat is the only loop.** Nothing else cycles — no spinners on cards, no shimmer, no oscillation.
- **No bounces.** Material-style spring overshoot is off-brand. Smooth ease-out only.

### Hover / press states

- **Buttons** — hover darkens by 6% (ink button → slightly darker ink); advisory hovers to `oklch(0.68 0.13 70)`.
- **Links / citations** — underline on hover, no color shift.
- **Press** — 1px inset translateY(1px), no shrink.
- **No hover glow. No color inversions on hover.**

### Borders

- **1px ink primary** on hero cards (the "in a book" look).
- **1px 10%-ink subtle** (`--rule`) on everything else.
- **1px dashed rule** for internal sub-groups inside a card.
- **2px advisory amber** for agent-layer left-rails on Heartbeat cards.

### Shadows

**Never used for elevation.** Depth is signaled by **border + background shift**, not shadow. opencoo is a printed book, not a glass UI. The only soft rule: a Heartbeat card on paper sits on `--paper` with its advisory-amber left rail — that's the entire elevation system.

### Radii

- `3px` chip / badge
- `4px` input
- `6px` card (default)
- `10px` sheet / iframe container

**Never pills.** Never fully rounded buttons. opencoo surfaces are documents, not capsules.

### Layout

- **4pt grid** for spacing: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 72`.
- **Max content width 1180px** on marketing; dashboards are full-width with internal gutters.
- **Hero uses a 1.1fr/1fr split** — mark left, manifest right.
- **Sidebar + canvas** on the management console (240px nav, fluid canvas).

### Transparency & blur

- **Transparency:** only used for `--rule` (10% ink). Nothing else transparent.
- **No backdrop-blur.** No frosted glass. No translucency.

### Imagery (when present)

- **Screenshots of the product** are the primary imagery. Warm paper background, no gradient overlays.
- **Photography** is avoided. If unavoidable: warm, muted, black-and-white; no skin-tone saturation tricks.

### Cards

- `1px solid var(--rule)` border · `6px` radius · `20px` padding · `var(--paper)` background.
- Heartbeat cards add the `2px` advisory-amber left rail.
- Wiki cards have a `paper-2` header stripe with the file path in mono.

---

## Iconography

The iconography system is **composed from the logo's three primitives**: open arc (`c`), filled disc (`o-compile`), and ring-with-dot (`o-operate`). Complex concepts are built from these — they are never invented from scratch.

- **Grid:** 24px · **Stroke:** 2px · **Corners:** rounded caps on arcs.
- **Hand-rolled SVG inline** — no icon font, no sprite sheet. The full set lives in `preview/iconography.html` and is rendered from a handful of `<circle>`/`<path>` primitives per icon.
- **Emoji is never used** in any icon-like context — not as a bullet, not in badges, not in Heartbeat headers. If it feels like it wants an emoji, it wants a glyph from the trio.
- **Unicode chars as icons** appear only in the CLI terminal skin: `◯ ● ◉` is the canonical trio-in-terminal, and `✓ → ` appear in log lines.

Available icons (in `preview/iconography.html`): `ingest`, `compile`, `operate`, `heartbeat`, `lint`, `chat / mcp`, `review`, `contradiction`, `automation`, `guard`, `domain`, `worldview`.

Partners need an icon not in this set? Compose it from the primitives first; if impossible, fall back to **Lucide** (CDN: `https://unpkg.com/lucide-static`) at 2px stroke, ink color, 24px grid. **Flag any Lucide use so we can promote common ones into the native set.**

### Key logos

All canonical in `assets/`:

- `logo-wordmark.svg` — full `opencoo` primary lockup
- `logo-wordmark-inverse.svg` — same, on ink
- `logo-trio-coo.svg` — monogram (c · o · o) for favicons, stickers, small spaces
- `glyph-c-open.svg` / `glyph-o-compile.svg` / `glyph-o-operate.svg` — individual primitives
- `app-icon.svg` — rounded-square app mark (compile glyph on paper)

**Minimum wordmark width** is 96px. Below that, use the monogram.

---

## Fonts

opencoo uses three Google-Fonts-hosted families — Geist, JetBrains Mono, Instrument Serif — loaded by `colors_and_type.css`. **No self-hosted TTFs shipped with this system yet.** If you are building for an offline environment, download these families from Google Fonts and place them under `fonts/`.

> **⚠️ Font substitution flag:** Geist, JetBrains Mono, and Instrument Serif are all Google Fonts (and all three are the genuine product choices, not substitutes). We've reference them from the CDN; if the customer requires self-hosted fonts, tell the user — we'll bundle TTFs.

---

## UI kits

| Kit | Path | What it covers |
|---|---|---|
| Management Console | `ui_kits/management-console/` | The admin surface — sidebar navigation, Review Dashboard, Heartbeat feed, Sources, Agents |

Each kit is a React+JSX prototype with a click-through `index.html`, reusable components, and its own README.

---

## Caveats

This system is distilled from the one canonical identity spec the user provided (`source/design-system.html`) plus the architecture doc. There is no shipping product yet, so:

- **No screenshots from a live app** exist yet; all UI here is recreated from the identity spec alone.
- **Font files not bundled** — Geist / JetBrains Mono / Instrument Serif load from Google Fonts.
- **Only one UI surface** is mocked (the Management Console). No marketing site, no CLI app, no docs site — they aren't defined yet in the source material.
