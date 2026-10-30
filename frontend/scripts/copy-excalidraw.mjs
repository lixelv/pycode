// Copies the whiteboard's fonts into public/excalidraw/ so they are served by
// us (the app's CSP and cross-origin isolation do not allow a font CDN).
import { cpSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "public", "excalidraw")
rmSync(out, { recursive: true, force: true })
cpSync(join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts"), join(out, "fonts"), { recursive: true })
console.log("excalidraw fonts → public/excalidraw/fonts/")
