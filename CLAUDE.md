
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## This project

Base64 Reduce: a Base64 image decoder and compressor. See README.md for commands and layout.

- `bun run check` runs `tsc` (TypeScript 7) and `bun test`; keep both green.
- `bun run dev` sets `DEV=1`: `bun --watch` restarts on server-side imports only, so `startServer` also watches `src/client` and rebuilds the bundle in place. A plain `bun start` serves the bundle built at startup.
- Async flows are guarded by generations: `inputGeneration` (app.ts, passed to imports.ts as begin/isCurrent) for imports and the clipboard, `generation` (compression-panel.ts) for compression results. Check them after every await before touching the DOM. compressor.ts only guarantees ordering (one encode at a time, latest waiting request wins); staleness is the panel's job.
- Typecheck is two passes (`bun run typecheck`): root `tsconfig.json` (server + tests, Bun types, no DOM) and `src/client/tsconfig.json` (DOM, no Bun types). Pure client modules imported by tests must not use DOM-only APIs.
- The client (`src/client`) is bundled in memory by `Bun.build` in `src/bundle.ts` rather than through HTML imports, because the page is rendered per origin (canonical URL, JSON-LD) and served with a strict CSP that hashes the inlined stylesheet.
- Fonts are declared in `styles.css` as `/fonts/<name>.woff2` and marked external: Bun's CSS bundler would otherwise inline them as data URIs.
- UI: one workbench with two states (`data-state="empty|ready"` on `#workbench`). Empty shows only the source card; ready shows a slim source bar, the stage (overlaid Original/Result and background controls) and one panel (result, then settings). `data-editing` reopens the Base64 field. `app.ts` owns the Base64 field and decoding, `imports.ts` every other way in, `stage.ts` the preview, `compression-panel.ts` settings and the result, `compressor.ts` the worker conversation.
- Visual rules: white/neutral ground, ink text, yellow `--sun` only as a fill paired with ink text (never yellow text on white; in light mode yellow fills get an ink edge). Mono type only inside the Base64 field. Check every change in both color schemes and on a phone-sized viewport with screenshots, not just axe.
- Compression runs in `src/client/reduce-worker.ts` (its own entry point in `src/bundle.ts`; its URL reaches the page through `data-worker` on `#workbench`). Candidates are ranked by data URI length (`dataUriLength` in formats.ts, the single source of format labels, MIME types and extensions), not file size. Pure modules (`png.ts`, `quantize.ts`, `svg.ts`, `inspect.ts`) are unit-tested in `test/reduce.test.ts`, including a PNG round-trip decoder.
- Editorial content (copy, FAQ, features) lives in `src/site/content.ts` and feeds the page, JSON-LD and llms.txt: edit it there only.
- All user-facing text is English, sentence case, numbers formatted `en-US`. Keep axe-core clean (labels, `aria-invalid`, `role="status"` announcements, ≥ 24 px targets).
