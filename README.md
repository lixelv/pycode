# polycode

![polycode: editor, file tree and console after running a program](docs/screenshot.png)

A small web IDE for learning Python. Python (Pyodide, CPython 3.14 compiled
to WebAssembly) and Ruff run in the browser, so no user code ever runs on a
server. A small Go backend (with Postgres) adds:

- **User ids:** a UUIDv7 kept in a cookie (`pc_uid`), issued on the first
  request.
- **Network proxy** for the in-browser Python (`/api/proxy`), so `requests`
  and friends can reach any public site. Local and private addresses are
  refused (the check runs on every resolved IP, redirects included).
  Limit: 256 requests per minute per user.
- **Live sessions** in the style of VS Code Live Share: one project (files,
  packages, console and the input line being typed), with everyone's cursor
  and selection. Changes go **peer to peer over WebRTC**. The server forwards
  signaling and relays data only for pairs that cannot connect directly.
- **Cursor colours:** take the user's UUID as a number `id`. Then
  hue = `id % 256` (spread over 360°) and saturation =
  `255 − (id >> 8) % 128` (100%…50%).

## Run it

```bash
docker compose up -d --build
```

Open http://localhost:8080. Use `PORT=9000 docker compose up -d --build` for another port.

Development:

```bash
docker run -d --name polycode-db -p 5432:5432 -e POSTGRES_USER=polycode -e POSTGRES_PASSWORD=polycode -e POSTGRES_DB=polycode postgres:17-alpine
cd backend && DATABASE_URL=postgres://polycode:polycode@localhost:5432/polycode?sslmode=disable go run ./cmd/server
cd frontend && npm install && npm run dev   # proxies /api to :8090
```

`npm run dev` and `npm run build` first copy the Pyodide runtime into
`public/pyodide/v<version>/`.

## Live sessions

Click **Share**, choose *Read & write* or *Read only*, and **Start session**.
You get a link (`/s/<code>`) and an 8-character code. Others join from the
link or by typing the code under **Share → Join**.

- **Running code:** it runs in the browser of whoever pressed Run. Its
  output, and its input() prompts, appear in everyone's console. Anyone who
  can write can type the input; the line is sent to the person running.
- **Read only:** only the owner edits, runs and types input. The server also
  drops document changes and signals from viewers.
- **Lifetime:** a session lasts until the owner presses *End for everyone*,
  or until it has been idle for 24 h.
- **Where the project lives:** in the owner's browser (IndexedDB). Guests
  edit it live; when they leave they are back in their own project. The
  server stores only session codes and roles, no content.
- **Transport:** members form a WebRTC mesh (Yjs sync and awareness over
  data channels). A pair that cannot connect directly (strict NAT, some VPNs)
  falls back to the server relay. Every receiver enforces read only using
  the roles the server announced.

## Projects

- **Files:** open the file tree with the button at the top left. You can
  create files and folders and delete them.
- **Formats:** Python, JSON, YAML/YML and Markdown get syntax highlighting.
  JSON also gets error checking and formatting. Anything else opens as
  plain text.
- **Run:** runs the open `.py` file, and the other project files can be
  imported. For a `.md` file, Run shows a rendered preview in the console
  area.
- **Saving:** the project is saved automatically in IndexedDB. ⌘S / Ctrl+S
  or the download button exports it as a `.zip`.
- **Archives:** the upload button opens a `.zip`. Every file in it is read as
  text.
- **Reset:** asks for confirmation, then starts your own project over with
  `main.py`.

Configuration (`.env` next to `docker-compose.yml`):

| Variable | Meaning |
|----------|---------|
| `PORT` | Public port (default 8080) |
| `POSTGRES_PASSWORD` | Database password |
| `PROXY_ALLOW_CIDRS` | Extra ranges the proxy treats as public. Only for VPNs with "fake IP" DNS, e.g. `198.18.0.0/15`. Loopback and private ranges can never be allowed. |

## How it works

| Piece | Where it runs |
|-------|---------------|
| Editor | Monaco |
| Linting and formatting | Ruff (WASM), errors only |
| Running code | Pyodide in a Web Worker. `input()` blocks on a `SharedArrayBuffer`. Stop and the 120 s timeout raise `KeyboardInterrupt`; if that doesn't work, the interpreter is replaced. |
| Code hints, flowchart, syntax tree | A second Pyodide worker (Jedi, `ast`), so hints still work while a program waits for input |
| Packages | `micropip`. Packages built for Pyodide (numpy, pandas…) come from cdn.jsdelivr.net; anything else comes straight from PyPI (both serve CORS). The resolved version is pinned after the first install. |

### Downloaded once

- **Hashed paths:** `/assets/*` and `/pyodide/v<version>/*` are served with
  `Cache-Control: immutable`.
- **Service worker** (`public/sw.js`): cache-first for those files, for
  Pyodide's CDN packages and for PyPI wheels. After the first visit the
  runtime, Ruff and every installed package load from the cache, offline too.
  PyPI's index is stale-while-revalidate.
- **Cross-origin isolation:** the page sends COOP/COEP headers, which
  `SharedArrayBuffer` (and so `input()`) requires.
