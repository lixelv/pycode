# pycode

A web IDE for teaching Python to beginners: a Monaco editor, a console
with interactive `input()`, a step-by-step flowchart of the program, a
project file tree and live sessions with students. Python (Pyodide) and
Ruff run **in the browser**. The Go backend only issues user ids, proxies
network requests and does signaling/relay for live sessions. It never
runs user code.

## Layout

```
frontend/   React 19 + Vite + Tailwind v4 + shadcn/ui (radix), served by nginx
backend/    Go 1.26: identity, network proxy, session signaling/relay (Postgres)
vscode/     Geist VS Code theme + "Geist Motion" (caret animation defaults)
docs/       README screenshot
```

## Commands

```bash
docker compose up -d --build              # whole stack; port comes from .env (PORT, currently 8081)
docker compose up -d --build frontend     # after frontend changes
cd frontend && npx tsc -b                 # type-check (run after every change)
cd frontend && npx oxlint src             # lint
cd frontend && npm run dev                # dev server, proxies /api to :8090
cd backend && gofmt -w . && go vet ./... && go test ./...
```

`npm run dev` and `npm run build` first run `scripts/copy-pyodide.mjs`. It
copies the Pyodide runtime into `public/pyodide/v<version>/` (gitignored)
and writes `src/generated/pyodide.ts`.

`.env` is gitignored. It holds `PORT` and, on this Mac only,
`PROXY_ALLOW_CIDRS=198.18.0.0/15`: the user's VPN uses fake-IP DNS, which
resolves every public host into 198.18/15. Without it the proxy refuses all
sites. Do not set it on a real server.

## Frontend architecture

- **Project = Y.Doc** (`src/lib/project/project.ts`), used alone and in
  sessions alike:
  - `files`: `Y.Map<Y.Text>` keyed by path;
  - `dirs`: explicit folders;
  - `packages`: `Y.Array`;
  - `terminal`: `Y.Text`, each run of text tagged with attribute `k` (stdout/stderr/stdin/system);
  - `run`: `Y.Map` holding status, exit, `executorClient` and `draft` (the input line being typed).

  The local project is persisted with `y-indexeddb`. A Y.Text cannot be
  moved, so rename, reset and zip import create new texts. The editor
  follows the Y.Text under its path (see `code-editor.tsx`) so that it
  never stays bound to a deleted one.
- **Running code**: `src/workers/runner.worker.ts` (Pyodide).
  - `input()` blocks on a `SharedArrayBuffer` and wakes via `Atomics`. This needs cross-origin isolation, so COOP/COEP headers are required in nginx and in vite.
  - Stop and the 120 s timeout raise `KeyboardInterrupt` through the interrupt buffer. If the program does not stop, the worker is terminated and recreated.
  - The whole project is written to `/home/pyodide/project`, and the open `.py` file runs as `__main__`.
  - HTTP from user code (`fetch`/XHR) is rewritten to `/api/proxy?url=`. `self.Worker` is deleted so urllib3 cannot start its own nested streaming worker, which would bypass the proxy.
- **Analysis**: `src/workers/tools.worker.ts` is a second Pyodide instance for Jedi hints, the flowchart and the syntax tree. It is separate so that hints keep working while a program waits for input. The Python sources are in `src/python/`, the flowchart builder in `flow.py`.
- **Console mirroring**: the console always renders from the doc. Whoever runs the program mirrors its output into the doc (`mirrorRun` in `App.tsx`). Others send `stdin`/`eof`/`stop` signals to `executorClient`.
- **Packages**: installed with micropip. Packages built for Pyodide come from cdn.jsdelivr.net, everything else from PyPI (both serve CORS). The resolved version is pinned after the first install.
- **Caching**: `public/sw.js` serves `/pyodide/`, `/assets/`, Pyodide CDN wheels and PyPI wheels cache-first. Real Safari/Chrome only; the in-app preview browser cannot register service workers.
- **Monaco** is slim (`src/lib/monaco-core.ts`: editor contributions only, no TS/CSS/HTML workers).
  - The Python tokenizer is our own (`src/lib/python-language.ts`): calls and `def` names → `function`, classes → `type`, brackets → `delimiter.*`.
  - The themes in `src/lib/monaco.ts` set bracket colours by depth (grey, yellow, purple, blue). Empty pairs stay grey via the `bracket-empty` decoration.
  - Models are created per file in `code-editor.tsx`, so model options such as `bracketColorizationOptions` must be set on the model, not only on the editor.
  - The editor is **uncontrolled** (`defaultValue`). A controlled `value` overwrites remote Yjs edits with a stale copy.
- **i18n**: `src/lib/i18n.ts` (EN/RU, default from the browser).
  - Every UI string goes through `t()` / `translate()`, with both `en` and `ru` entries.
  - Flowchart captions are translated in Python (`tr()` and `_RU` in `flow.py`); the language reaches the worker as `lang`.
  - Kind tags are translated in `kindTag()` in `lib/flow.ts`.
- **Flowchart layout**: ELK (`elkjs`, lazy-loaded) in `src/lib/flow.ts`, hierarchical and orthogonal. Do not go back to dagre: it crashes on compound graphs and routes edges through cards.
- **Theme**: dark by default, toggle in the footer. The footer and console are always black (the `--console*` tokens). The palette is Vercel/Geist: tokens in `src/index.css`, Monaco themes in `lib/monaco.ts`.
- **No page scroll**: `body` is `position: fixed` and sized with `100svh`/`100dvh`. The user saw page scrollbars in Safari, so keep this.

## Live sessions

- **Transport** (`src/lib/collab/provider.ts`): a WebRTC mesh.
  - Each link starts on the **server relay**, which is usable immediately. A data channel is negotiated in the background and takes over once open.
  - When the channel drops, the link falls back to the relay and retries with backoff. Only the lower peer id starts retries.
  - Data is the Yjs sync protocol plus awareness plus runner signals. Messages are chunked to 60 KB.
- **Roles** (owner/editor/viewer) come from the server. Receivers drop doc changes and signals from viewers.
- **The project lives with the owner**: the owner shares their local doc, and a guest gets a fresh doc that is thrown away on leaving (back to their own project). The server stores no content.
- **Reset in a session**: owner only. The client announces it with `{"type":"reset"}`; the server relays it only from the owner and replies `error` otherwise.
- **Cursor colour** (`lib/collab/identity.ts`): hue = `id % 256` scaled to 360°, saturation = `255 − (id >> 8) % 128`, lightness 60%.

## Backend

- **`identity`**: a UUIDv7 in the `pc_uid` cookie, issued on the first request.
- **`proxy`**: `/api/proxy?url=`.
  - Public IPs only. The check runs in the dialer `Control` hook on every connection (redirects included). Literal IPs and `localhost`/`.local`/`.internal` are refused up front.
  - 256 requests per minute per user.
- **`session`**: Postgres stores session rows only (code, owner, mode). Rooms live in memory. WebSocket protocol:
  - text frames: JSON control (`welcome`, `join`, `leave`, `signal`, `reset`, `error`, `ended`);
  - binary frames: relay, `[to u32][payload]` from the client and `[from u32][payload]` to it.

  Idle sessions expire after 24 h.
- nginx must forward `Host $http_host`. Without the port, the websocket Origin check fails with 403.

## Gotchas

- **The shadcn CLI** (`npx shadcn add …`) rewrites `import { cn } from "@/lib/utils"` to `from "cn"` and installs the npm package `cn`. After adding a component, fix the import and `npm uninstall cn`.
- **Dropdown and context-menu inputs**: Radix menus hold focus while open. Inline inputs opened from a menu must focus after it closes (`useFocusAfterMenu` in `file-tree.tsx`), and menus use `onCloseAutoFocus={e => e.preventDefault()}`.
- **Puppeteer headless hides scrollbars**: pass `ignoreDefaultArgs: ["--hide-scrollbars"]`. On macOS, Cmd shortcuts do not reach Monaco in headless Chrome. For WebKit (Safari engine), Playwright's webkit is installed in the scratchpad.
- **WebRTC cannot connect P2P on this Mac**: the VPN's TUN interface is the only host candidate, so tests always end up on the relay. That is expected.
- **Nested Python modules** in `src/python/` are bundled with `?raw` and written into the workers' virtual FS as the package `pycoder`.

## Conventions

- **Text**: UI copy in English, with Russian in `i18n.ts`. The user writes in Russian; reply in Russian.
- **Checks**: after changes run `npx tsc -b`, rebuild the container and verify in a browser (end-to-end scripts with puppeteer-core against real Chrome).
- **Commits**: only when asked. Messages end with the attribution line from the system prompt.
