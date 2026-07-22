# Contributing to Last Refuge

Thanks for your interest in contributing! Last Refuge is a post-apocalyptic
city builder for the browser, built with Vite + Three.js and no UI framework.
This document covers local setup, tests, code conventions and the pull
request workflow.

## Local setup

Requires Node.js 22+ (the same version used by the deploy workflow).

```bash
npm install
npm run dev
```

then open http://localhost:5173 in your browser. Progress is saved
automatically to `localStorage` at every dawn; add `?new=1` to the URL to
start over and `?seed=N` for a specific map.

## Running tests

```bash
npm test
```

The suite runs on [Vitest](https://vitest.dev) and lives in `tests/`. It
covers the simulation (`src/sim/`), the building definitions and everything
else that can be exercised without a browser. If your change touches game
logic, add or update the corresponding test file.

To verify a production build locally:

```bash
npm run build
npm run preview
```

## Code conventions

- **Plain ES modules, no framework.** The UI is a minimal DOM overlay on top
  of a full-screen WebGL canvas — no React/Vue, no JSX, no build-time magic.
- **Factory modules.** Each module exports a `createX(root, ...)` factory
  (e.g. `createHud(root)`, `createPlacement({ scene, grid, ... })`) that
  builds the instance, wires its callbacks and returns its public interface.
  Keep module state inside the factory closure — no exported mutable
  singletons.
- **DOM via the local `h()` helper.** UI modules build elements with a small
  local `h(tag, className, text)` helper (a thin wrapper around
  `document.createElement`). Each UI file defines its own; keep it that way.
- **No DOM access at import time.** All elements are created inside the
  factory, never at module top level, so every module stays importable from
  Node (tests) without a browser.
- **`src/sim/` must stay pure.** The simulation (state, economy, survivors,
  waves, weather…) imports neither the DOM nor three.js and must remain
  safe to import in Node tests. Game rules live here; rendering and input
  live in `src/core/`, `src/world/`, `src/buildings/` and `src/zombies/`.
- **Comments and docs.** Each file opens with a short comment describing
  what the module does; exported factories carry a JSDoc block documenting
  parameters and the returned interface. All user-facing text and
  documentation is in English.
- **No new dependencies** unless the change genuinely needs one — discuss it
  in an issue first.

See the "Code structure" section of [README.md](README.md) for a tour of
the directories.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the PR focused: one feature or one fix per PR, minimal diffs.
3. Run `npm test` before submitting — the deploy workflow
   (`.github/workflows/deploy.yml`) runs the same suite on every push to
   `main`, and a red suite blocks the release.
4. Describe *what* changed and *why*. For gameplay changes, mention the
   effect on balance (resources, horde size, yields); for visual changes,
   attach a screenshot.
5. Every push to `main` auto-deploys to GitHub Pages, so all changes land
   through PR review.

Not sure where to start? Look for issues labeled
[`good first issue`](https://github.com/D590900/city-builder-survival/labels/good%20first%20issue).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE). Note that the 3D assets remain the property of their
respective authors — see [CREDITS.md](CREDITS.md).
