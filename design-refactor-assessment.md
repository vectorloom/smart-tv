# Smart TV Dashboard Design Refactor Assessment

## Assessment

**Verified:** The frontend is a small React app with one global stylesheet, not a component-library or CSS-module setup. It already has album and photo grids, a weather panel, keyboard and phone-remote navigation, and responsive rules.

**Scope note:** The brief describes a prior dashboard mockup, but no mockup image or other visual reference was included here. This plan uses the written charcoal-and-amber direction and starter palette.

## 1. Frontend inventory

- **Entry and page selection:** `src/web/src/main.tsx` imports the global stylesheet and selects `Settings`, `Remote`, or `App` based on the URL path. There is no router library.
- **Dashboard:** `src/web/src/App.tsx` loads albums and paginated photos, renders the dashboard header, weather, album/photo grids, pairing controls, and starts the slideshow.
- **Gallery playback:** `src/web/src/Slideshow.tsx` owns playback, interval selection, shuffle, image loading, temporary controls, and exit behavior.
- **Weather:** `src/web/src/WeatherPanel.tsx` renders current conditions, hourly and daily forecasts, loading/error states, and a seven-minute refresh timer.
- **Remote and administrator pages:** `src/web/src/Remote.tsx` provides phone pairing and controls. `src/web/src/Settings.tsx` is the separate administrator interface.
- **Navigation and data:** `src/web/src/navigation.ts` implements geometry-based arrow focus and editing-field detection. `src/web/src/remote.ts` handles the remote connection. `src/web/src/api.ts` contains API helpers and data types.
- **Styling:** `src/web/src/styles.css` contains all frontend styling: global controls, dashboard, gallery, slideshow, weather, phone remote, settings, focus rules, and media queries. Styles are mostly hardcoded and densely written; there are no existing theme variables or reusable style files.
- **Tests:** `App.test.tsx`, `Slideshow.test.tsx`, `WeatherPanel.test.tsx`, `Settings.test.tsx`, and `navigation.test.ts` cover frontend behavior. Browser tests live in `src/web/e2e/`.

## 2. Layout and navigation

The dashboard is a vertical document: header, main content, phone-pairing section, and footer. The weather panel appears above the album grid on the album page; opening an album replaces it with the photo grid. Album and photo collections use CSS Grid. There is no dashboard-wide card grid or fixed-position layout. The page can scroll vertically; the main content has no fixed height or general overflow clipping.

At wide sizes the album grid uses four columns and the photo grid five. At 1100px both use three columns; at 700px they use two. The weather forecast changes from a two-column forecast area to one column at 1100px, and its hourly grid becomes three columns at 700px. The dashboard has a 2100px maximum width and uses viewport-based side padding. Text and controls enlarge at 1500px. These rules support a range of screens, but the current arrangement does not establish a compact 16:9 TV composition; the weather panel and generous vertical spacing can push albums lower on screen.

Keyboard arrows call `moveFocus`, which finds enabled buttons, selects, and explicit tab stops by their on-screen geometry. Enter, Space, Escape/Backspace, and Home are handled by the dashboard; editing controls retain native handling. The slideshow has its own key handling and focus boundary. Tab order is primarily DOM order on the dashboard; the slideshow explicitly cycles Tab within its frame and controls. Focus returns to the slideshow launch control or previously selected album. The phone sends commands through the same navigation path.

Focus styling currently uses a pale green ring for buttons, selects, links, and inputs. A general `:focus` rule keeps focus visible for remote commands as well. When adding wrappers or changing grid geometry, preserve the current focusable elements and their positions; arrow movement depends on rendered geometry. Weather forecast cells are intentionally not focusable, keeping dashboard navigation on interactive controls.

## 3. Proposed visual architecture

Keep the current component structure and establish the theme in `styles.css` with CSS custom properties for background, card surface, border, text, muted text, amber accent, focus ring, spacing, and radii. Use those tokens to restyle the existing dashboard shell, gallery cards, and weather panel. Treat the weather panel and collection tiles as the first modular widgets; leave room in the layout for future widgets without introducing a new abstraction or changing data behavior.

The written direction implies replacing the existing green-toned surfaces and accents with charcoal, graphite, and amber. Keep text and controls sized for TV viewing, and use a 16:9 test viewport when tuning spacing and card density.

## 4. Incremental implementation plan

| Priority | Existing files likely to change | Planned work | Main risk |
|---|---|---|---|
| 1. Theme foundation | `src/web/src/styles.css` | Define color, spacing, radius, and focus tokens; replace scattered theme colors and normalize shared control/card borders. | A broad color replacement could affect the remote and administrator pages, which share the stylesheet. Scope dashboard changes carefully and preserve readable contrast. |
| 2. Dashboard shell | `src/web/src/App.tsx`, `src/web/src/styles.css` | Refine header, content width, vertical rhythm, and dashboard layout for 16:9 use. Reuse existing markup unless a layout wrapper is needed. | New wrappers or changed grid positions can alter geometry-based arrow navigation and initial focus. |
| 3. Reusable card styling | `src/web/src/styles.css`; `App.tsx` only if existing classes are insufficient | Apply consistent graphite surfaces, subtle borders, rounded corners, hover/selected treatments, and spacing to album and photo cards. | Card padding, transforms, or aspect ratios can change focus geometry, image crop, and visible item count. |
| 4. Gallery and weather styling | `src/web/src/styles.css`; `WeatherPanel.tsx` only if markup needs a styling hook; `Slideshow.tsx` only if its controls need visual hooks | Restyle weather, loading/error notices, photo tiles, and slideshow overlays while leaving data loading, refresh, and playback logic alone. | Weather content is dense; shrinking it too far harms across-room readability. Slideshow styles share the theme but must retain overlay visibility behavior. |
| 5. Amber focus and remote compatibility | `src/web/src/styles.css`; `navigation.ts` only if layout testing reveals a real navigation issue | Replace the green focus treatment with a high-contrast amber outline and suitable offset/shadow on every interactive control. Keep the existing navigation model. | Focus rings can be clipped by `overflow: hidden` on cards or obscured by adjacent content; test keyboard and phone-driven focus. |
| 6. Responsive sizing and TV validation | `src/web/src/styles.css`; likely validation in `src/web/e2e/gallery.spec.ts` | Tune breakpoints, card density, typography, and scrolling at 1920×1080 and narrower sizes. Validate on Fire TV/Silk hardware. | Emulator behavior may differ from Silk in key events, font rendering, fullscreen, and image decoding. |

No backend, API, database, settings, or dependency changes are indicated by this design work. The three selected albums are loaded through the existing API; the visual refactor should not touch their persisted configuration.

## 5. Regression risks and mitigation

- **Focus and arrow movement:** The focus algorithm uses element geometry. Verify arrows at card-row edges, between dashboard sections, and after responsive reflow. Preserve enabled controls and avoid adding decorative focusable elements.
- **Focus visibility:** Card overflow and tight spacing may clip the amber outline. Check all buttons, selects, inputs, and links, including slideshow and phone-remote controls.
- **Weather:** Keep `WeatherPanel` refresh, stale-data, loading, and failure behavior unchanged. Its forecast cells are display-only by design.
- **Slideshow:** Keep interval timing, transitions, image readiness, temporary overlay hiding, and focus restoration unchanged.
- **Shared stylesheet:** `styles.css` also styles `/remote` and `/settings`; dashboard-specific selectors or tokens should avoid unintended administrator or phone UI changes.
- **Scroll and TV framing:** Do not hide overflow or force a fixed-height dashboard without checking access to lower cards, pairing controls, and footer.

## 6. Existing tests and build commands

Configured frontend scripts in `src/web/package.json`:

- Unit tests: `npm test --prefix src/web`
- Production frontend build (TypeScript check plus Vite build): `npm run build --prefix src/web`
- Browser tests: `npm run test:browser --prefix src/web`; `scripts/test-browser.sh` is also present and sets the default Chromium executable path.
- API tests: `scripts/test-api.sh`, which runs the API test project with the project-local .NET SDK.

For an approved visual implementation, run frontend unit tests and the production build before and after the change, then browser tests for navigation and responsive overflow. API tests are useful as a full-regression check, but this CSS-focused refactor does not change API code. The browser configuration targets 1920×1080 by default; existing gallery, slideshow, and remote browser specs are in `src/web/e2e/`.

I did not run tests or builds; this was an inspection-only assessment, as requested. No files were changed during that assessment.

## 7. Fire TV/Silk validation checklist

- At 1920×1080, check card density, weather legibility, margins, and whether the primary gallery content is visible without excessive scrolling.
- Navigate album and photo grids with a physical remote; verify directional movement and activation at row boundaries.
- Confirm the amber focus ring remains visible on cards, pairing controls, slideshow controls, and selects.
- Verify Tab order and Enter/OK activation, plus Escape/Back behavior in gallery and slideshow.
- Confirm phone remote pairing and directional commands continue to work.
- Check slideshow controls appear and hide as before; verify image loading and fullscreen fallback.
- Check narrower browser sizes for horizontal overflow and reachable content.
- Confirm weather refresh and stale/error presentation remain intact.

## 8. Decisions needed

No decision is required to prepare the implementation. The written brief is sufficient to begin the refactor once you approve it.
