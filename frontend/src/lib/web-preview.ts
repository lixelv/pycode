import { cleanPath, mimeOf, parentOf } from "@/lib/project/project"

/*
 * A page of the project shown in a sandboxed iframe (no same-origin, so a
 * student's script cannot reach the app). The iframe cannot load the
 * project's other files by URL, so they are inlined as data: URLs, and a
 * small script forwards console output and errors to the app.
 */

type Files = Record<string, string | Uint8Array>

const TEXT_MIME: Record<string, string> = { css: "text/css", js: "text/javascript", mjs: "text/javascript", html: "text/html", svg: "image/svg+xml" }

function base64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function dataUrl(path: string, content: string | Uint8Array): string {
  const ext = path.toLowerCase().split(".").pop() ?? ""
  const mime = TEXT_MIME[ext] ?? mimeOf(path)
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  return `data:${mime}${typeof content === "string" ? ";charset=utf-8" : ""};base64,${base64(bytes)}`
}

const external = (ref: string) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)

/** The project file a reference in `from` points to, as a data: URL (or the reference unchanged). */
function inline(files: Files, from: string, ref: string, depth = 0): string {
  if (external(ref)) return ref
  const clean = ref.split(/[?#]/)[0]
  const dir = parentOf(from)
  const path = cleanPath(clean.startsWith("/") ? clean : dir ? `${dir}/${clean}` : clean)
  const content = path ? files[path] : undefined
  if (content === undefined || !path) return ref
  // A stylesheet's own url(...) references are inlined too.
  if (typeof content === "string" && path.endsWith(".css") && depth < 3) return dataUrl(path, inlineCss(files, path, content, depth + 1))
  return dataUrl(path, content)
}

function inlineCss(files: Files, path: string, css: string, depth = 0): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_, q: string, ref: string) => `url(${q}${inline(files, path, ref, depth)}${q})`)
}

/** Forwards console.* and errors to the parent as {polycode: token, kind, text}. */
function bridge(token: string): string {
  return `<script>(() => {
  const token = ${JSON.stringify(token)}
  const show = (v) => { if (typeof v === "string") return v; try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } }
  const send = (kind, args) => parent.postMessage({ polycode: token, kind, text: [...args].map(show).join(" ") + "\\n" }, "*")
  for (const [name, kind] of [["log", "stdout"], ["info", "stdout"], ["debug", "stdout"], ["warn", "stderr"], ["error", "stderr"]]) {
    const original = console[name].bind(console)
    console[name] = (...args) => { send(kind, args); original(...args) }
  }
  addEventListener("error", (e) => send("stderr", [e.message + (e.lineno ? " (line " + e.lineno + ")" : "")]))
  addEventListener("unhandledrejection", (e) => send("stderr", ["Uncaught (in promise) " + show(e.reason?.message ?? e.reason)]))
  addEventListener("load", () => parent.postMessage({ polycode: token, kind: "loaded" }, "*"))
})()</script>`
}

/** The HTML page at `entry`, with the project's files inlined and the console bridge added. */
export function buildPage(files: Files, entry: string, token: string): string {
  const html = String(files[entry] ?? "")
  const body = html
    .replace(/(<(?:link|script|img|source|audio|video|iframe)\b[^>]*?\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi, (_, start: string, q: string, ref: string) => `${start}${q}${inline(files, entry, ref)}${q}`)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open: string, css: string, close: string) => open + inlineCss(files, entry, css) + close)
  // The bridge must run before the page's own scripts.
  return /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + bridge(token)) : bridge(token) + body
}

/** A page that only runs one script file (Run on a .js file). */
export function scriptPage(js: string, token: string): string {
  return `<!DOCTYPE html><html><head>${bridge(token)}</head><body><script src="${dataUrl("main.js", js)}"></script></body></html>`
}
