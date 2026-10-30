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
cd frontend && npx vitest run             # unit tests (project model, access, archives, web preview, Prettier)
cd frontend && npm run dev                # dev server, proxies /api to :8090
cd backend && gofmt -w . && go vet ./... && go test ./...
```

`npm run dev` and `npm run build` first run `scripts/copy-pyodide.mjs` and
`scripts/copy-excalidraw.mjs`:
- the Pyodide runtime goes into `public/pyodide/v<version>/` (gitignored), and `src/generated/pyodide.ts` is written;
- the whiteboard fonts go into `public/excalidraw/fonts/` (gitignored).

`.env` is gitignored. It holds `PORT` and, on this Mac only,
`PROXY_ALLOW_CIDRS=198.18.0.0/15`: the user's VPN uses fake-IP DNS, which
resolves every public host into 198.18/15. Without it the proxy refuses all
sites. Do not set it on a real server.

## Frontend architecture

- **Project = a set of Y.Docs** (`ProjectStore`, `src/lib/project/store.ts`), used alone and in sessions alike. Each document is synced and access-checked on its own:

  | Document | Contents |
  |---|---|
  | `structure` | `files` (path → `FileMeta {id, kind, size, hash?, mime?, protected?, hidden?}`), `dirs`, `packages`, `roles` (custom role → read/write), `folders` (folder → role), `state` (`frozen`, `presentation`) |
  | `runtime` | `terminal` (`Y.Text`, runs tagged with `k`), `run` (status, exit, `executorClient`, `draft`, `debugging`, `debug`) |
  | `board` | whiteboard `elements` and `files` |
  | `f:<id>` | one text file (`getText("t")`) |

  - All documents share one client id (`store.clientID`).
  - A rename only moves metadata, so open editors stay bound.
  - Text docs are created and dropped by following `structure.files`.
  - Persistence: `y-indexeddb`, one database per document (`pycode:<docId>`).
  - The old single-document project (`python-coder:project`) is migrated on first start (`localStore()` in `project.ts`).
  - The editor follows the file's document under its path (a reset or an opened archive puts new ids under the same paths).
- **Binary files** (`lib/project/blobs.ts`):
  - Bytes are kept by sha256 in the IndexedDB database `pycode:blobs`; the project holds only the metadata.
  - Text or binary is decided by `isText()`: known text extensions win, then known binary extensions, then a UTF-8 check.
  - The project is limited to 64 MB (`PROJECT_LIMIT`; texts plus each distinct binary file plus board pictures).
  - Archives keep binary files and the access rules (`.pycode.env`, line format, see `access.ts`). That name is reserved at the root.
- **Access** (`lib/project/access.ts`, pure, unit-tested):
  - A member is `{level, roles[], owner?}`: a level (read < write < admin; the owner is an admin) plus any number of custom roles.
  - `fileAccess` applies, in order: hidden → none; every role folder on the path must be one of the member's roles; protected or frozen → read.
  - `docAccess` maps documents to access: `structure` is written by admins only; `runtime` and `board` by write.
  - `useAccess` (hook) gives the UI the same answers. Tree changes, packages, freeze and presentation are admin-only. `*.test.py` files are created hidden.
- **Running code**: `src/workers/runner.worker.ts` (Pyodide). Binary files are written next to the texts.
  - The program may be someone else's (a teacher runs a student's file), and the worker shares the app's origin and cookie. So of our own site it reaches only `/pyodide/` and `/api/proxy`; `fetch` is replaced on every prototype; IndexedDB, caches, WebSocket, EventSource and WebTransport are removed. In a session, running a different file starts a fresh interpreter.
  - `input()` blocks on a `SharedArrayBuffer` and wakes via `Atomics`. This needs cross-origin isolation, so COOP/COEP headers are required in nginx and in vite.
  - Stop and the 120 s timeout raise `KeyboardInterrupt` through the interrupt buffer. If the program does not stop, the worker is terminated and recreated.
  - The whole project is written to `/home/pyodide/project`, and the open `.py` file runs as `__main__`.
  - HTTP from user code (`fetch`/XHR) is rewritten to `/api/proxy?url=`. `self.Worker` is deleted so urllib3 cannot start its own nested streaming worker, which would bypass the proxy.
- **Debugger** (`python/debugger.py`, a `bdb.Bdb`):
  - Started with `run(files, entry, specs, breakpoints)`. Breakpoints belong to the browser (localStorage `pycode:breakpoints`).
  - On a stop the worker posts `paused` and waits on the stdin slot (`DEBUG_WAITING` → `DEBUG_GO` with the command in `[1]`). Stop wakes it with `STDIN_INTERRUPT`.
  - Debug runs have no time limit.
  - In a session the executor mirrors the stop into `run.debug`, so everyone sees the line.
  - bdb keeps breakpoints globally and loads them in `__init__`: clear them before `super().__init__()`.
- **Automatic checks** (`python/checker.py`):
  - `name.test.py` holds `test_*` functions; `pycode_test.run(stdin)` runs the solution and returns its output, without `input()` prompts.
  - Checks run in an admin's browser, in a fresh `RunnerClient` (`check()`), with fetch/XHR/WebSocket/IndexedDB/caches removed and a 30 s limit.
  - A student sends signal `check` to `provider.checker()` (the acting owner if admin, else the earliest admin) and gets `check-result` back.
  - The admin runs checks one at a time, at most one per student every 3 s.
  - Only the tests' own failed asserts carry a message. Errors raised by the solution report only a built-in type name, so the solution cannot send anything back. Results come from code the student controls: they help learning, they are not grades.
- **What a run sees** (`runVisible` in `access.ts`, used by `projectFiles`): every run, check and preview gets public files plus the role folders the entry file is in, never hidden files. A teacher running a student's program therefore does not expose tests or other students' work.
- **Web files**:
  - Monaco's HTML, CSS and TypeScript services are registered in `monaco-core.ts`. `MonacoEnvironment.getWorker` must route by label (css/html/typescript); otherwise the services fail silently.
  - HTMLHint checks HTML (`lib/web-lint.ts`). Prettier formats HTML/CSS/JS/Markdown (`lib/prettier.ts`, loaded on demand).
  - Run on `.html` or `.js` uses `lib/web-preview.ts`: the page is built with the project's files inlined as `data:` URLs, plus a console bridge.
  - It runs in `<iframe sandbox="allow-scripts …" src="/preview.html">`, which has no same origin. The page arrives by postMessage.
  - `/preview.html` has its own permissive CSP in `nginx.conf`, and its loader is inline: a sandboxed frame has an opaque origin, so CORP same-origin refuses even our own scripts. A `srcdoc` frame would inherit the app's CSP and block every script.
- **Documents**: PDF via `pdfjs-dist`, PPTX via `pptx-preview` (`components/doc-viewer.tsx`, one page at a time, page controlled by the parent).
- **Presentation**: an admin presents a PDF or PPTX to everyone (`state.presentation = {path, page, by}`). Only the presenter turns pages; any admin can end it if the presenter is gone.
- **Markdown**: Code / Side by side / Preview switch (localStorage `pycode:md-mode`). The preview resolves project pictures.
- **Whiteboard** (`components/board.tsx`, Excalidraw, lazy):
  - Elements are synced by version via `reconcileElements`. Pictures go into `board.files`.
  - Pointers travel in awareness (`boardPointer`), the visible area in `boardView` (for Follow).
  - Fonts are served from `/excalidraw/` (`EXCALIDRAW_ASSET_PATH`).
- **Session UX**:
  - Names: asked on joining when the session's `askName` is set; kept per session id.
  - Cursor name labels: footer toggle (`pycode:cursor-labels`).
  - Follow: `hooks/use-follow.ts`; awareness `view {tab, file, top}`.
  - Freeze: `state.frozen`; `components/frost-overlay.tsx` animates `--frost`, which is registered with `@property`.
  - Drag and drop onto the page: `hooks/use-file-drop.ts` (admins); the tree rows carry `data-path` / `data-kind`.
- **Analysis**: `src/workers/tools.worker.ts` is a second Pyodide instance for Jedi hints, the flowchart and the syntax tree. It is separate so that hints keep working while a program waits for input. The Python sources are in `src/python/`, the flowchart builder in `flow.py`.
- **Console mirroring**: the console always renders from the doc. Whoever runs the program mirrors its output into the doc (`mirrorRun` in `App.tsx`). Others send `stdin`/`eof`/`stop` signals to `executorClient`.
- **Packages**: before every run (and check) the runner loads the Pyodide packages the project's `.py` files import (`loadPackagesFromImports`), so `import numpy` works without the Packages tab. Other packages are installed with micropip from the Packages tab. Packages built for Pyodide come from cdn.jsdelivr.net, everything else from PyPI (both serve CORS). The resolved version is pinned after the first install.
- **Caching**: `public/sw.js` serves `/pyodide/`, `/assets/`, Pyodide CDN wheels and PyPI wheels cache-first. Real Safari/Chrome only; the in-app preview browser cannot register service workers.
- **Monaco** is slim (`src/lib/monaco-core.ts`): editor contributions, our Python, and the HTML/CSS/TypeScript services (see Web files); none of the other languages.
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
  - Messages are chunked to 60 KB:
    - `MSG_SYNC [docId][y-sync]`;
    - awareness;
    - signals (`stdin`/`eof`/`stop`/`check`/`check-result`);
    - `MSG_BLOB_GET`/`MSG_BLOB_PART`: binary files, 1 MB parts fetched one at a time, owner first, served only to those who may see a file with that hash.
- **Access per document**:
  - A document's updates go only to members who may read it.
  - Step 1 is answered only to readers; step 2 and updates are applied only from writers (rules read from our own `structure`).
  - When a document becomes readable, we ask for it.
  - Consequence: `structure` and protected or hidden files come only from admins, so a newcomer with no admin online sees "waiting for the teacher".
- **Roles** come from the code a member joined with (`read`, `write`, `admin`, or a custom role, which gives its level plus that role). The owner (by cookie) is always owner.
  - The owner or an admin changes a connected member's level and roles from the share dialog (`provider.setRole` → WS `setRole`); the server checks `canSetRole`:
    - an admin changes members below admin and cannot make admins;
    - the owner changes anyone but themself.
  - Everyone gets `{"type":"role"}` and access follows at once. The change is kept in `session_members` and wins over the join code on reconnect.
- **Acting owner**: the server picks `room.owner` (the owner while connected, else the admin who joined first) and broadcasts `{"type":"owner"}`. Reset is accepted only from the acting owner.
- **The project lives with the owner**: the owner shares their local store, and a guest gets a fresh in-memory store that is dropped on leaving.
- **Cursor colour** (`lib/collab/identity.ts`): hue = `id % 256` scaled to 360°, saturation = `255 − (id >> 8) % 128`, lightness 60%. Names next to cursors are off unless toggled.

## Backend

- **`identity`**: a UUIDv7 in the `pc_uid` cookie, issued on the first request. The cookie id is the credential: it never leaves the server. Others (and `/api/me`) see `identity.Public(id)`, a hash.
- **`proxy`**: `/api/proxy?url=`.
  - Public IPs only. The check runs in the dialer `Control` hook on every connection (redirects included). Literal IPs and `localhost`/`.local`/`.internal` are refused up front.
  - 256 requests per minute per user.
- **`session`**: Postgres stores session rows (owner, `ask_name`), `session_codes` (code → role, level) and `session_members` (level and roles given during the session). `sessions.code` is the write code. REST:
  - `POST /api/sessions {askName, roles}` creates a session and returns every code;
  - `GET /api/sessions/{code}`;
  - `GET …/codes` and `POST …/roles` (owner or a connected admin).

  Rooms live in memory. WebSocket protocol:
  - text frames: JSON control (`welcome` with `owner`, `join`, `leave`, `owner`, `role`, `setRole`, `signal`, `reset`, `error`, `ended`); peers carry `level`, `roles` and `owner`;
  - binary frames: relay, `[to u32][payload]` from the client and `[from u32][payload]` to it.

  Idle sessions expire after 24 h.
- nginx must forward `Host $http_host`. Without the port, the websocket Origin check fails with 403.

## Gotchas

- **The shadcn CLI** (`npx shadcn add …`) rewrites `import { cn } from "@/lib/utils"` to `from "cn"` and installs the npm package `cn`. After adding a component, fix the import and `npm uninstall cn`.
- **Dropdown and context-menu inputs**: Radix menus hold focus while open. Inline inputs opened from a menu must focus after it closes (`useFocusAfterMenu` in `file-tree.tsx`), and menus use `onCloseAutoFocus={e => e.preventDefault()}`.
- **Puppeteer headless hides scrollbars**: pass `ignoreDefaultArgs: ["--hide-scrollbars"]`. On macOS, Cmd shortcuts do not reach Monaco in headless Chrome. For WebKit (Safari engine), Playwright's webkit is installed in the scratchpad.
- **WebRTC cannot connect P2P on this Mac**: the VPN's TUN interface is the only host candidate, so tests always end up on the relay. That is expected.
- **Nested Python modules** in `src/python/` are bundled with `?raw` and written into the workers' virtual FS as the package `pycoder`.
- **The e2e hook**: with `localStorage["pycode:e2e"]` set, the app exposes `window.__pycode = {store, provider}`. In tests:
  - fetch `/api/me` once before the app loads: parallel first requests get different identity cookies;
  - wait a moment after writing before reloading: y-indexeddb flushes asynchronously.
- **htmlhint** has no types for its browser build: see `src/htmlhint.d.ts`.

## Conventions

- **Text**: UI copy in English, with Russian in `i18n.ts`. The user writes in Russian; reply in Russian.
- **Checks**: after changes run `npx tsc -b`, rebuild the container and verify in a browser (end-to-end scripts with puppeteer-core against real Chrome).
- **Commits**: only when asked. Messages end with the attribution line from the system prompt.
