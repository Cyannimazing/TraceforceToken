# TraceForce generated brand assets

Created 2026-10-12 using the built-in image generation tool, not the fallback API/CLI. The selected images are copied into the project and do not depend on the original Codex image directory at runtime.

| Asset | Purpose |
| --- | --- |
| `traceforce-mark.png` | Transparent TraceForce emblem used in the site header and social preview |
| `traceforce-app-icon.png` | Selected simplified cyan, white and amber icon with a transparent background |
| `icon-192.png`, `icon-512.png` | Manifest exports of the selected icon |
| `../../src/app/icon.png` | 32px browser tab icon |
| `../../src/app/favicon.ico` | Embedded-PNG favicon for browser compatibility |
| `../../src/app/apple-icon.png` | 180px Apple touch icon |

`scripts/export-brand-icons.ts` exports the selected icon at standard platform sizes using Next.js ImageResponse. It does not draw a different emblem. Re-run with `npx tsx scripts/export-brand-icons.ts` after deliberately choosing a replacement source image.

## Final prompt set

Logo generation, transparent background:

> Use case: logo-brand. Create a final standalone TraceForce Engine emblem: a bold angular T integrated with a precise orbital tracing path and a single small amber point. Cyan #22d3ee, ice white and amber #fbbf24. Strong geometric, vector-like, balanced square composition, recognizable at 24px. Isolated on a genuinely transparent background. No words, mockup, stars, tiny circuitry, excessive bloom, 3D or gradients outside the mark.

Matching icon edit, using `traceforce-mark.png` as the reference, opaque background:

> Create a matching square app icon. Preserve the angular T, orbital path and amber point. Simplify to thick flat cyan and white; remove facets, gritty speckles, stray pixels, glow and tiny details. Large mark on a uniform deep navy #050b14 rounded-square tile with 12% safe padding, readable at 32px. No text, mockup, outside shadow or extra objects.

Transparent icon edit, using the selected app icon as the edit target:

> Use case: background-extraction. Remove only the deep-navy rounded-square tile and white outer corner background. Preserve the existing cyan-outlined angular T, white interior, cyan-and-white orbital path and amber endpoint, including their proportions, positions, colors and safe padding. Keep the emblem opaque and use genuine PNG alpha transparency outside and between its shapes. No redesign, text, shadow, glow, painted checkerboard or background.

Generated originals: `exec-759dafa5-a389-47c8-a8d4-93deaf63d4e0.png` (mark), `exec-3dd4414c-37e7-486b-97c7-1be1b6135d4c.png` (initial opaque icon), and `exec-5eefcfd4-8f0d-474b-8d6b-c8d75028dad5.png` (selected transparent icon edit). The current icon and all platform exports have verified PNG alpha transparency, including the PNG embedded in the favicon. The icon PNG is shared across browser themes; the page and browser chrome theme colors follow the visitor's preference.
