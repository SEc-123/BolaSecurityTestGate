# Product Design QA: Internationalization Closure

## Feedback To Fix Matrix

| User feedback | Failure mode | Product diagnosis | Fix pattern | Affected surfaces | Verification |
| --- | --- | --- | --- | --- | --- |
| The product is all English and cannot switch languages. | Internationalization was not designed into the product shell. | Language was treated as static copy instead of product state. | Added a shared i18n provider, catalog, DOM bridge, document language sync, persisted preference, and URL language state. | App entry, shell, navigation, topbar, Assessment page, existing routed pages through runtime bridge. | `npm run test:i18n`; screenshots in `artifacts/i18n-ui-smoke-2026-06-29T20-27-26-498Z/`. |
| At least two language switching paths are required. | Only one hardcoded rendering path existed. | Users had no visible control or shareable language state. | Added topbar segmented EN/中文 switch, `?lang=en|zh` URL entry, persisted local preference, and `Ctrl/Cmd+Shift+L` shortcut. | Global shell and all routes mounted under the app root. | Browser smoke validates URL zh entry, EN button switch, shortcut back to zh, and narrow viewport persistence. |
| Frontend text is hardcoded everywhere. | Product copy is scattered across pages and components. | Future text would keep bypassing localization unless there is a structural gate. | Added `src/i18n` catalog/translator and `scripts/i18n-coverage-check.mjs` to enforce core/high-frequency coverage; migrated Assessment dynamic units and mode controls to explicit `t()`. | `src/main.tsx`, `src/components/Layout.tsx`, `src/pages/AIScans.tsx`, all current pages through bridge coverage. | `npm run check:i18n` reports 426 catalog entries, 1468 visible candidates, and only intentional high-frequency leftovers: HTTP methods and sample values. |

## Implementation Scope

- `src/i18n/` now owns language types, catalog entries, exact and fragment translation, provider state, URL/localStorage sync, keyboard toggle, and DOM bridge coverage for legacy hardcoded text.
- `src/components/Layout.tsx` now exposes a product-level language switch in the topbar and explicitly localizes navigation, section labels, runtime status, and current-page metadata.
- `src/pages/AIScans.tsx` now explicitly localizes dynamic run status, metric units, launch settings, driving-mode cards, scan-depth cards, account-mode cards, and Chinese-authored source labels.
- `tests/i18n/run-i18n-ui-smoke.mjs` verifies URL, button, keyboard, desktop, and narrow/mobile language behavior with screenshots.
- `scripts/i18n-coverage-check.mjs` gives the project a repeatable static gate so future UI text does not silently drift back into unlocalized hardcoding.

## Verification

- `npm run check:i18n` passed.
- `npm run typecheck` passed.
- `npm run build:frontend` passed with the existing Vite large chunk warning.
- `npm run test:i18n` passed and captured:
  - `artifacts/i18n-ui-smoke-2026-06-29T20-27-26-498Z/01-zh-desktop.png`
  - `artifacts/i18n-ui-smoke-2026-06-29T20-27-26-498Z/02-en-desktop.png`
  - `artifacts/i18n-ui-smoke-2026-06-29T20-27-26-498Z/03-zh-mobile.png`

## Known Boundaries

- User data, URLs, IDs, HTTP methods, code/preformatted blocks, inputs, and sample values intentionally remain untranslated.
- New product copy should go into `src/i18n/catalog.ts` or call `t()` directly; the DOM bridge is a compatibility net for the existing scattered frontend, not a replacement for cataloged product copy.

final result: passed
