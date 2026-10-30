import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { migrateStorage } from "./lib/storage"

// Old browser data must be moved before anything reads or opens it, so the
// rest of the app (which reads localStorage and IndexedDB at load) comes after.
await migrateStorage()
await import("./lib/monaco")
const { default: App } = await import("./App.tsx")

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Cache Python, Ruff and packages so they are downloaded only once.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}
