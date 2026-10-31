# polycode

A web IDE for teaching Python and C++ to beginners: a Monaco editor, a console
with interactive input, a step-by-step flowchart of the program, a project
file tree and live sessions with students. Python (Pyodide), Ruff and clang
(WebAssembly) run **in the browser**. The Go backend only issues user ids, proxies
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
cd frontend && npx vitest run             # unit tests (project model, access, archives, web preview, Prettier, C++ tree/flowchart, clang diagnostics and client, C++ runner and output decoding, console error lines)
cd frontend && npm run dev                # dev server, proxies /api to :8090
/opt/homebrew/bin/python3.14 -m unittest discover -s frontend/src/python/tests   # checker and other Python sources (unittest only)
cd backend && gofmt -w . && go vet ./... && go test ./...
```

`npm run dev` and `npm run build` first run `scripts/copy-pyodide.mjs`,
`scripts/copy-excalidraw.mjs` and `scripts/copy-tree-sitter.mjs`:
- the Pyodide runtime goes into `public/pyodide/v<version>/` (gitignored), and `src/generated/pyodide.ts` is written;
- the whiteboard fonts go into `public/excalidraw/fonts/` (gitignored);
- tree-sitter's runtime (`tree-sitter.wasm`) and the C++ grammar (`tree-sitter-cpp.wasm`) go into `public/tree-sitter/` (gitignored).

`.env` is gitignored. It holds `PORT` and, on this Mac only,
`PROXY_ALLOW_CIDRS=198.18.0.0/15`: the user's VPN uses fake-IP DNS, which
resolves every public host into 198.18/15. Without it the proxy refuses all
sites. Do not set it on a real server.

## Frontend architecture

- **Project = a set of Y.Docs** (`ProjectStore`, `src/lib/project/store.ts`), used alone and in sessions alike. Each document is synced and access-checked on its own:

  | Document | Contents |
  |---|---|
  | `structure` | `files` (path → `FileMeta {id, kind, size, hash?, mime?, protected?, hidden?}`), `dirs`, `packages`, `roles` (custom role → read/write), `folders` (folder → role), `state` (`frozen`, `presentation`, `languages`) |
  | `runtime` | `terminal` (`Y.Text`, runs tagged with `k`), `run` (status, exit, `executorClient`, `draft`, `debugging`, `debug`) |
  | `board` | whiteboard `elements` and `files` |
  | `f:<id>` | one text file (`getText("t")`) |

  - All documents share one client id (`store.clientID`).
  - A rename only moves metadata, so open editors stay bound.
  - Text docs are created and dropped by following `structure.files`.
  - Persistence: `y-indexeddb`, one database per document (`polycode:<docId>`).
  - The old single-document project (`python-coder:project`) is migrated on first start (`localStore()` in `project.ts`). Without old data a new project starts empty, so its language is asked for.
  - Old browser data is moved by `migrateStorage()` (`lib/storage.ts`), which `main.tsx` awaits before importing the app (i18n reads localStorage at load): `pycode:*` and `python-coder:*` keys (except `python-coder:code`/`packages`, read by the legacy migration) become `polycode:*`, and `pycode:*` IndexedDB databases are copied to `polycode:*` and then deleted. An existing new name is never overwritten.
  - The editor follows the file's document under its path (a reset or an opened archive puts new ids under the same paths).
- **Languages** (`project.ts`): `state.languages` is `("python" | "cpp")[]`.
  - `languagesOf` reads it; an old project without it gets them from its files (`.py`; `.cpp .cc .cxx .h .hpp`), an empty one is python.
  - `addLanguagesFor` adds a file's language in `createFile`, `addFiles` and `openArchive` (an archive replaces them with its own; none → python). Deleting a file never removes one.
  - An empty project without `languages` (`needsLanguage`: first start, Reset) shows `LanguageDialog` (Python or C++ card) only in our own local store, never to a session guest, even an admin standing in for the owner (`!isGuest`). `startProject` writes `languages` and the starter (`STARTERS`: `main.py`, `main.cpp`). Closing the dialog = Python. Reset deletes every file and `languages`, so it asks again.
  - The Python runtimes (runner warm-up via `useRunner({warm})`, Ruff) load only when the project is ready, has its language and includes python (`hasPython` in `App.tsx`, read on `structure` updates). A C++-only project makes no `/pyodide/` request until a `.py` file adds python. The tools worker is lazy (Python hints, flowchart).
- **Binary files** (`lib/project/blobs.ts`):
  - Bytes are kept by sha256 in the IndexedDB database `polycode:blobs`; the project holds only the metadata.
  - Text or binary is decided by `isText()`: known text extensions win, then known binary extensions, then a UTF-8 check.
  - The project is limited to 64 MB (`PROJECT_LIMIT`; texts plus each distinct binary file plus board pictures).
  - Archives keep binary files and the access rules (`.polycode.env`, line format, see `access.ts`). That name is reserved at the root, as is the old `.pycode.env` (still read when `.polycode.env` is absent).
- **Access** (`lib/project/access.ts`, pure, unit-tested):
  - A member is `{level, roles[], owner?}`: a level (read < write < admin; the owner is an admin) plus any number of custom roles.
  - `fileAccess` applies, in order: hidden → none; every role folder on the path must be one of the member's roles; protected or frozen → read.
  - `docAccess` maps documents to access: `structure` is written by admins only; `runtime` and `board` by write.
  - `useAccess` (hook) gives the UI the same answers. Tree changes, packages, freeze and presentation are admin-only. `*.test.py` files are created hidden.
- **Running code**: `src/workers/runner.worker.ts` (Pyodide). Binary files are written next to the texts.
  - The program may be someone else's (a teacher runs a student's file), and the worker shares the app's origin and cookie. So of our own site it reaches only `/pyodide/` and `/api/proxy`; `fetch` is replaced on every prototype; IndexedDB, caches, WebSocket, EventSource and WebTransport are removed. In a session, running a different file starts a fresh interpreter.
  - `input()` blocks on a `SharedArrayBuffer` and wakes via `Atomics`. This needs cross-origin isolation, so COOP/COEP headers are required in nginx and in vite.
    - `input()` on a tty reads once more after an empty read, so `readLine` answers the read right after an EOF with EOF too; otherwise Ctrl+D takes two presses.
  - Stop and the 120 s timeout raise `KeyboardInterrupt` through the interrupt buffer. If the program does not stop within 2 s, the worker is terminated and recreated.
    - Pyodide gets `signalBuffer(raw)` (`lib/python/signal-buffer.ts`), not the raw buffer: its signal check always writes 0 after reading, which erased a Stop written in between, so the write happens only after a read that saw a signal. Reading must not consume (no `Atomics.exchange`): `checkInterrupt` peeks at the buffer while `input()` blocks. A unit test fails if Pyodide's helper changes.
    - Interrupts are armed only just before `exec` (`run_main(..., arm=)`, also under the debugger) and in `check()` before the tests (a check's time limit is an interrupt), and removed after the run. A Stop during boot, a package load or the project write stays in the buffer and is raised when the program starts, so Pyodide's own Python never sees it. `RunnerClient.run` clears the flag before waiting for `ready`.
    - `time.sleep` is replaced once per interpreter (`install_sleep`, at boot): `sliced_sleep` sleeps at most 50 ms at a time and calls `checkInterrupt` after each slice, since Pyodide polls the buffer only now and then. Stop and a check's limit reach a sleeping program at once, and `except KeyboardInterrupt` catches it.
    - `startRun` asks `runner.allowRun()` (8 runs per second, `lib/run-limit.ts`) before `resetRun`: a refused run must not touch the shared state. `run`/`runCpp` take the `projectFiles` promise and begin before it resolves, so a Stop during that wait ends the run at once and the program never starts.
  - The whole project is written to `/home/pyodide/project`, and the open `.py` file runs as `__main__`.
  - User code cannot `import polycode`: `boot()` imports every module once, keeps the proxies in `polycode`, then `hideSources` removes the package from `sys.modules`, `sys.path` and the disk. So never call `py.pyimport("polycode.…")` after boot, and a module of the package must not import a not-yet-loaded package at its top (`packages.py` imports micropip inside `install`). This is tidiness, not security: `gc` can still reach the modules.
  - HTTP from user code (`fetch`/XHR) is rewritten to `/api/proxy?url=`. `self.Worker` is deleted so urllib3 cannot start its own nested streaming worker, which would bypass the proxy.
- **Debugger** (`python/debugger.py`, a `bdb.Bdb`):
  - Started with `run(files, entry, specs, breakpoints)`. Breakpoints belong to the browser (localStorage `polycode:breakpoints`).
  - On a stop the worker posts `paused` and waits on the stdin slot (`DEBUG_WAITING` → `DEBUG_GO` with the command in `[1]`). Stop wakes it with `STDIN_INTERRUPT`.
  - Debug runs have no time limit.
  - In a session the executor mirrors the stop into `run.debug`, so everyone sees the line.
  - bdb keeps breakpoints globally and loads them in `__init__`: clear them before `super().__init__()`.
- **Automatic checks** (`python/checker.py`):
  - `name.test.py` holds `test_*` functions; `polycode_test.run(stdin)` (limits below; alias `pycode_test` for old tests) runs the solution and returns its output, without `input()` prompts.
  - Checks run in an admin's browser, in a fresh `RunnerClient` (`check()`), with fetch/XHR/WebSocket/IndexedDB/caches removed and a 30 s limit.
  - `polycode_test.module` (lazy, cached per check): the solution's top-level declarations (imports, defs, classes, assignments without a call), compiled under the solution's filename; the program itself does not run. A C++ solution (`run_tests(..., kind="cpp")`) gets `TypeError`.
  - Limits: `run(stdin, timeout=None, ram_usage=None)`, seconds and MB (10⁶ bytes); `None`/`0` turn a limit off.
    - Time: `run()` calls the worker's JS global `polycode_deadline(ms)` → event `deadline {ms, gen}` → `RunnerClient` sets a timer that calls `interrupt()`. Cancelling (`ms` 0) is synchronous through `control[2]` (`lib/python/deadline.ts`): a late timer finds its generation gone, and a written but untaken interrupt is cleared, so nothing reaches code after `run()`; it returns whether the timer fired (fired counts as exceeded). `KeyboardInterrupt` becomes `TimeLimitExceeded(TimeoutError)`; the elapsed `perf_counter` time is compared too, so a program that swallows the interrupt still fails.
    - Memory: `tracemalloc` peak around the program, checked after it ends → `MemoryLimitExceeded(MemoryError)`.
    - Both carry `used`/`limit` as floats; `_failure` builds their message from `float()` of those only, capped by `_short` (`time limit 1 s exceeded: 1.43 s`, `memory limit 64 MB exceeded: 81.2 MB`).
    - Measures: a limit that is on is measured per test (`time` summed, `memory` peak in bytes) into `CheckResult.time`/`memory` (coerced to numbers, never overriding name/ok/message), shown at the right of the test's line (`0.12 s · 3.4 MB`).
    - `_deadline` and `_now` are module hooks the CPython unit tests replace (`python/tests/test_checker.py`).
  - **C++ solutions** (`name.cpp` + `name.test.py`, `testPathOf`): `checkHere` compiles with the project's C++ packages (a failure becomes the error `check.compileFailed` with the log's first 5 lines); `RunnerClient.check(..., wasm)` keeps the wasm on the page. `polycode_test.run` is then `_run_cpp` → `_run_wasm` → the worker's `polycode_run_wasm`: it posts `run_wasm` with a fresh result SAB (`BATCH_*` in `protocol.ts`) and blocks in `Atomics.wait`; the page runs `cpp-run.worker` in `batch` mode (stdin is the test's text, then EOF, so reading too much does not hang). On timeout the worker posts `kill_wasm` and the page terminates it. Without `timeout` the wait is what is left of 30 s. `memory` is the linear memory at the end; time is measured around the hook, so it includes starting the worker. Prompts are part of the output. `run()` raises, whatever was printed, after the time and memory limits and in this order: cut by the output limit (`output limit exceeded`), did not start, including a cpp-run worker that failed to load (`the program did not start`), non-zero exit or a trap (`exit code <n>`). The header's state says which (`BATCH_EXITED`/`_OUTPUT_LIMIT`/`_NOT_STARTED`); the messages are fixed text or the integer, and no argument allows a non-zero exit.
  - A student sends signal `check` to `provider.checker()` (the acting owner if admin, else the earliest admin) and gets `check-result` back.
  - The admin runs checks one at a time, at most one per student every 3 s.
  - **C++ solutions**: `checkHere` compiles on the admin's page (`cppClient.compile`, with the project's packages, outside the 30 s limit; a failed compile is the check's error with the first 5 log lines), then runs the tests in a fresh `RunnerClient` with `kind="cpp"`. `run()` (`_run_cpp`) blocks on the JS global `polycode_run_wasm(stdin, ms)`, which runs the wasm on the page. Input past `stdin` is EOF; the output includes prompts, since they are ordinary `cout`. Without `timeout` it may use what is left of the check.
    - Exit status: a program that exits non-zero or crashes (`ExitCodeError`, `exit code N`), is cut by the output limit (`OutputLimitExceeded`) or does not start (`ProgramNotStarted`) fails the test, whatever it printed. Time and memory limits are checked first.
    - `memory` can read low: `-O1` removes an unused allocation.
  - Only the tests' own failed asserts carry a message. Other errors raised by the solution report only a built-in type name, or `error`. The exception: a Python solution can reach the checker through `sys.modules` and raise its time and memory limit errors itself (the exit and output errors count only for `kind="cpp"`), so digits of its choosing can come back, up to the `_short` cap. The C++ path builds these errors in the checker from the run's numbers, and no program output gets into them. Results come from code the student controls: they help learning, they are not grades.
- **What a run sees** (`runVisible` in `access.ts`, used by `projectFiles`): every run, check and preview gets public files plus the role folders the entry file is in, never hidden files. A teacher running a student's program therefore does not expose tests or other students' work.
- **Web files**:
  - Monaco's HTML, CSS and TypeScript services are registered in `monaco-core.ts`. `MonacoEnvironment.getWorker` must route by label (css/html/typescript); otherwise the services fail silently.
  - HTMLHint checks HTML (`lib/web-lint.ts`). Prettier formats HTML/CSS/JS/Markdown (`lib/prettier.ts`, loaded on demand).
  - Run on `.html` or `.js` uses `lib/web-preview.ts`: the page is built with the project's files inlined as `data:` URLs, plus a console bridge.
  - It runs in `<iframe sandbox="allow-scripts …" src="/preview.html">`, which has no same origin. The page arrives by postMessage.
  - `/preview.html` has its own permissive CSP in `nginx.conf`, and its loader is inline: a sandboxed frame has an opaque origin, so CORP same-origin refuses even our own scripts. A `srcdoc` frame would inherit the app's CSP and block every script.
- **Documents**: PDF via `pdfjs-dist`, PPTX via `pptx-preview` (`components/doc-viewer.tsx`, one page at a time, page controlled by the parent).
- **Presentation**: an admin presents a PDF or PPTX to everyone (`state.presentation = {path, page, by}`). Only the presenter turns pages; any admin can end it if the presenter is gone.
- **Markdown and HTML**: Code / Side by side / Preview switch (localStorage `polycode:md-mode`, `polycode:html-mode`).
  - The Markdown preview resolves project pictures.
  - The HTML preview (`LivePagePreview`) rebuilds the page 300 ms after each change in the same `SandboxFrame` that Run uses. Its console is shown only by Run.
- **Whiteboard** (`components/board.tsx`, Excalidraw, lazy):
  - Elements are synced by version via `reconcileElements`. Pictures go into `board.files`.
  - Pointers travel in awareness (`boardPointer`), the visible area in `boardView` (for Follow).
  - Fonts are served from `/excalidraw/` (`EXCALIDRAW_ASSET_PATH`).
- **Session UX**:
  - Names: asked on joining when the session's `askName` is set; kept per session id.
  - Cursor name labels: footer toggle (`polycode:cursor-labels`).
  - Follow: `hooks/use-follow.ts`; awareness `view {tab, file, top}`.
  - Freeze: `state.frozen`; `components/frost-overlay.tsx` animates `--frost`, which is registered with `@property`.
  - Drag and drop onto the page: `hooks/use-file-drop.ts` (admins); the tree rows carry `data-path` / `data-kind`.
- **C++** (`.cpp .cc .cxx .h .hpp`, `languageOf` → `"cpp"`):
  - Highlighting: Monaco's Monarch `cpp` grammar (`languages/definitions/cpp/register.js` in `monaco-core.ts`). No formatting, hints or debugger.
  - Clang is `@yowasp/clang` (LLVM 22 built for WebAssembly, sysroot `wasm32-wasip1`) in `src/workers/cpp.worker.ts`, driven by `cppClient` (`lib/cpp/client.ts`). The worker starts on the first lint or compile, never for a project without C++: the toolchain is 105 MB (≈27 MB gzipped), fetched and compiled once per worker. `useCppStatus()` drives the footer ("Loading C++ compiler…").
  - Requests go one at a time; a lint still queued is replaced by a newer one. Once the compiler is loaded, a lint may run 15 s and a compile 30 s (`LINT_DEADLINE_MS`/`COMPILE_DEADLINE_MS`); past that the worker is terminated, every pending request fails and the next one starts a fresh worker. A failed download shows "C++ compiler failed to load" (status `failed`) and is tried again on the next request. The project lies under `/project`, packages under `/packages/<repo>/…` (`CppPackageFiles`, from `loadCppPackages`). Paths in the log are made relative (`/project/` cut).
  - **C++ packages** (`lib/cpp/packages.ts`, `hooks/use-cpp-packages.ts`, `components/cpp-packages-panel.tsx`): header-only libraries from GitHub through jsDelivr, in `structure.cppPackages` (Y.Array of `CppPackage {spec, repo, ref, version?, include?, status, error?}`; admins change it, `replaceProject` clears it, an opened archive keeps it). The Packages tab shows for every file with a packages system (`packagesKind !== null`) and renders the Python or the C++ panel.
    - Install (`fetchCppPackage`): version = `ref` or `data.jsdelivr.com/v1/packages/gh/<repo>/resolved`; the flat file list (`…/<repo>@<version>?structure=flat`) gives the include folder (`include`, else `single_include`, else the root) and the headers inside it (`.h .hpp .hh .hxx .ipp .inl .tpp`, or no extension); more than 2000 files or 32 MB (by the listed sizes) fails before any download; files come from `cdn.jsdelivr.net/gh/<repo>@<version>/<path>`, 8 at a time. Errors carry "not found" / "no headers" / "too large". The version is pinned on the entry after the first install (`ref` is used as is, a tag stays a tag).
    - `loadCppPackages(list, onFail)` gives clang `/packages/<repo>/<path>` files and `-I/packages/<repo>/<include>`, from an in-memory cache by `repo@version` (a package that fails to load is left out and reported through `onFail(repo, version, message)`; `useCppPackages` then shows it as an error via `applyLoadFailures`, keyed `repo@version` and marked `loadFailed` (never written to the doc), so lints do not re-request it; the failures are reset when the list's document changes. Retry on such an entry, also for a read-only member, only clears the local failure, and the next lint loads it again; the shared list is written only to retry a stored `error`). Everyone loads the packages of the list lazily before a lint; only the admin who adds one downloads it at once. `sw.js` serves `cdn.jsdelivr.net/gh/…` and `data.jsdelivr.com/v1/packages/gh/…` cache-first only when the `@version` is a release tag (`v1.2.3`, `3.11.3`; three numbers) or a 40-hex commit SHA, never a branch or a moving tag (`v4`, `3`). `parseCppSpec` rejects `.`/`..` as owner, repo or a path segment of the ref.
  - Lint: `clang++ -fsyntax-only -std=c++20 -fno-color-diagnostics -I<entry folder> -I/project [-I packages] /project/<entry>`, 500 ms after edits, on `projectFiles` (what a run sees) with the editor's text. `parseClangDiagnostics` (`lib/cpp/diagnostics.ts`) keeps the open file's problems; errors in a header show at the entry's `#include` line (clang's "In file included from"), notes are dropped. Markers have source `clang`; warnings are Monaco warnings and are not counted in the footer.
  - Compile: `-std=c++20 -O1 -Wl,--max-memory=1073741824`, linked with `src/cpp/stub.cpp` (built once per worker). The sysroot has no exception runtime, so the stub's `__cxa_throw` prints g++'s "terminate called after throwing…" and aborts (`try/catch` compiles but never catches); its constructor does `chdir(getenv("POLYCODE_CWD"))`.
  - Run (`useRunner().runCpp`, called from `startRun` in `App.tsx`, the one `cppClient.compile` call site): status `compiling` ("Compiling…", always written to the doc, since `resetRun` leaves `connecting`, which reads "Starting Python…") → a failed compile puts clang's log in stderr and exits with code 1 → else `cppRunner` (`lib/cpp/runner-client.ts`) runs the wasm in `src/workers/cpp-run.worker.ts` with `@bjorn3/browser_wasi_shim` (`lib/cpp/wasi.ts`: `runWasm`, `Stdin`, `projectTree`, `Utf8Out`, shared with the `batch` mode of checks).
    - stdin blocks on the same `RunnerBuffers`/`STDIN_*` protocol as `input()`; Ctrl+D answers one read with EOF. stdout/stderr are decoded with `stream: true` (`Utf8Out`).
    - The worker posts every write at once: the program is synchronous, so no timer can run there, and Stop terminates the worker, so anything held would be lost. `CppRunnerClient` coalesces on the page: a 16 ms timer, one event per run of the same kind, in order. Past `MAX_BATCH_EVENTS` (64) in a batch, writes of either kind join the last event: all text arrives in order, and only the colour of lines in an alternating stdout/stderr flood can be wrong. Pending output is emitted before any other event and before `KeyboardInterrupt`.
    - Files: `projectFiles` under the preopened `/project`; cwd is the entry's folder (`cwdOf`, env `PWD` and `POLYCODE_CWD`, which the stub's constructor `chdir`s to).
    - Output limit 1 000 000 bytes (stdout + stderr): the program is cut (exit 130, reason `output_limit`) at a character boundary (`utf8Boundary`), so no U+FFFD before the limit message. A trap exits 134 (`abort`, an uncaught `throw` with the stub's message); traps other than `unreachable` also print their message.
    - A wasm program cannot be interrupted: Stop and the 120 s limit (`useRunner`'s timer) call `interrupt()`, which terminates the worker, starts a new one and emits stderr `\nKeyboardInterrupt\n` plus `exit` 130 at once.
    - `useRunner` drives both runners through `ProgramRunner` (`protocol.ts`: `on`, `sendLine`, `sendEof`, `interrupt`, `restart`): only the current run's runner's events count, input and Stop (also from session signals) go to it, and starting a run restarts the other one if it was still running. So `mirrorRun` is the same for both. A Stop during compilation finishes the run at once and the compile result is dropped.
    - Headers (`.h`, `.hpp`) do not run. The console paints clang's `file:L:C: error:`, `wasm-ld: error:`, `clang++: error:` and `terminate called…` lines red (`ERROR_LINE`, `lib/console-lines.ts`).
  - Vite: `optimizeDeps.exclude` has `@yowasp/clang` (pre-bundling breaks its relative asset URLs), and `build.assetsInlineLimit` never inlines `.wasm`/`.tar` (a `data:` URL is refused by the CSP's `connect-src`). nginx serves `.tar` as `application/x-tar` and gzips it; `/assets/` is cache-first in the service worker.
- **Analysis**: `src/workers/tools.worker.ts` is a second Pyodide instance for Jedi hints, the flowchart and the syntax tree. It is separate so that hints keep working while a program waits for input. The Python sources are in `src/python/`, the flowchart builder in `flow.py`.
  - Jedi gets its own `Project` whose `sys_path` leaves out `/home/pyodide`, so `polycode` is never suggested. In `*.test.py` (the request's `path`) `sys_path` also has `polycode_stubs`, written from `python/stubs/polycode_test.py`: signatures and docs only, kept equal to `checker.py` by `tests/test_stub.py`.
- **C++ syntax tree and flowchart** (`src/lib/cpp/`): parsed on the page by `web-tree-sitter` + `tree-sitter-cpp` (`parse.ts`, lazy; in vitest the wasm is read from `node_modules`). The versions are pinned exactly: the runtime must accept the grammar's ABI. The frontend image runs `npm ci --ignore-scripts`: `tree-sitter-c`/`-cpp` have node-gyp install scripts that fail on Alpine (no Python), and nothing else needs one.
  - `cppTree` (`tree.ts`) returns the same `AstResponse` as `ast_tree.py`: named nodes, leaves carry `value`, edges are labelled with grammar field names; `categorize(type, "cpp")` colours them.
  - `cppFlow` (`flow.ts`) mirrors `flow.py` (same `FlowResponse`, `MAX_NODES`, call links resolved after building, en/ru captions in its own `RU` table). Every function, class and method is a frame; `main` gets Program start/end. A `switch` is a chain of conditions, one per `case`.
  - A syntax error is the first `ERROR`/`MISSING` node. Columns are converted to UTF-8 bytes, like Python's, so `sourceSegment` and reveal work the same.
  - `AstDialog` takes `language` and calls these instead of the tools worker.
- **Console mirroring**: the console always renders from the doc. Whoever runs the program mirrors its output into the doc (`mirrorRun` in `App.tsx`). Others send `stdin`/`eof`/`stop` signals to `executorClient`.
  - The input line is `run.draft`, read straight from the doc (`useSharedDraft`, `useSyncExternalStore`) with no local copy: `useSharedConsole` updates a frame late, and such a copy put back over the input lost the last keystrokes when Enter followed quickly.
  - `StderrText` renders runs of lines (`stderrRuns`, `lib/console-lines.ts`), not a span per line: 100 000 spans keyed by index froze the page for tens of seconds when the terminal was trimmed from the front.
- **Packages**: before every run (and check) the runner loads the Pyodide packages the project's `.py` files import (`loadPackagesFromImports`), so `import numpy` works without the Packages tab. Other packages are installed with micropip from the Packages tab. Packages built for Pyodide come from cdn.jsdelivr.net, everything else from PyPI (both serve CORS). The resolved version is pinned after the first install.
- **Caching**: `public/sw.js` serves `/pyodide/`, `/assets/`, Pyodide CDN wheels and PyPI wheels cache-first. Real Safari/Chrome only; the in-app preview browser cannot register service workers.
- **Monaco** is slim (`src/lib/monaco-core.ts`): editor contributions, our Python, C++ highlighting, and the HTML/CSS/TypeScript services (see Web files); none of the other languages.
  - The Python tokenizer is our own (`src/lib/python-language.ts`): calls and `def` names → `function`, classes → `type`, brackets → `delimiter.*`.
  - The themes in `src/lib/monaco.ts` set bracket colours by depth (grey, yellow, purple, blue). Empty pairs stay grey via the `bracket-empty` decoration.
  - Models are created per file in `code-editor.tsx`, so model options such as `bracketColorizationOptions` must be set on the model, not only on the editor.
  - The editor is **uncontrolled** (`defaultValue`). A controlled `value` overwrites remote Yjs edits with a stale copy.
- **i18n**: `src/lib/i18n.ts` (EN/RU, default from the browser).
  - Every UI string goes through `t()` / `translate()`, with both `en` and `ru` entries.
  - Flowchart captions are translated in Python (`tr()` and `_RU` in `flow.py`); the language reaches the worker as `lang`. C++ captions: `RU` in `lib/cpp/flow.ts`.
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
- **Nested Python modules** in `src/python/` are bundled with `?raw` and written into the workers' virtual FS as the package `polycode`.
- **The e2e hook**: with `localStorage["polycode:e2e"]` set, the app exposes `window.__polycode = {store, provider}`. In tests:
  - fetch `/api/me` once before the app loads: parallel first requests get different identity cookies;
  - wait a moment after writing before reloading: y-indexeddb flushes asynchronously.
- **htmlhint** has no types for its browser build: see `src/htmlhint.d.ts`.

## Conventions

- **Text**: UI copy in English, with Russian in `i18n.ts`. The user writes in Russian; reply in Russian.
- **Checks**: after changes run `npx tsc -b`, rebuild the container and verify in a browser (end-to-end scripts with puppeteer-core against real Chrome).
- **Commits**: only when asked. Messages end with the attribution line from the system prompt.
