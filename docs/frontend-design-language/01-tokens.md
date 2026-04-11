# 01. Design Tokens — SnackVoice Web

## Color Tokens

Derived from the SnackVoice app's `App.css` design language.

```css
--bg:           #2c2b29   /* Primary dark background (warm, not pure black) */
--bg-deeper:    #1e1d1b   /* Deeper sections / gradient bottoms */
--bg-card:      #302f2d   /* Card / surface backgrounds */
--bg-glow:      #3a3260   /* Purple glow overlay (radial gradient center) */

--text:         #fbfbfb   /* Primary text */
--text-muted:   #9490a0   /* Secondary / body copy */
--text-subtle:  #6a6580   /* Captions, fine print */

--accent:       #7c6feb   /* Primary purple — CTAs, icons, highlights */
--accent-light: #9b90f0   /* Lighter purple — hover states, badges */
--accent-deep:  #2a1f6e   /* Deep purple — logo stroke, gradient anchor */
--accent-hover: #6a5ed8   /* CTA button hover */

--border:       #3d3c3a   /* Standard border */
--border-subtle:#2e2d2b   /* Section dividers */
```

## Typography

- UI font: `Inter`, -apple-system fallback chain
- Hero scale: `clamp(48px, 7vw, 84px)`, weight 800, letter-spacing -2px
- H2 scale: `clamp(28px, 4vw, 42px)`, weight 800, letter-spacing -1px
- Body: `18px`, weight 400, line-height 1.6
- Small: `14px`

Weight tokens:
- 400 — body, descriptions
- 600 — nav links, labels, button text
- 700 — card titles, step titles
- 800 — hero, section headings

## Radius

- `--radius-sm: 6px` — buttons, small chips
- `--radius-md: 12px` — success steps, small cards
- `--radius-lg: 20px` — feature cards, pricing card
- `--radius-pill: 999px` — eyebrow badges, pill CTAs

## Spacing

- Container: `min(1200px, 100% - 48px)`
- Section gap: `96px`
- Card padding: `28px`

## Elevation & Effects

- Hero glow: radial gradient from `rgba(124,111,235,0.18)` center → transparent
- Sticky nav: `backdrop-filter: blur(12px)` + `rgba(44,43,41,0.85)` bg
- Card hover: border transitions to `rgba(124,111,235,0.4)`
- CTA hover: `translateY(-1px)` lift
