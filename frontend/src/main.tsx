import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { migrateStorage, withTimeout } from "./lib/storage"

// Old browser data must be moved before anything reads or opens it, so the
// rest of the app (which reads localStorage and IndexedDB at load) comes after.
await withTimeout(migrateStorage(), 3000)
await import("./lib/monaco")
const { default: App } = await import("./App.tsx")

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Cache Python, Ruff and packages so they are downloaded only once.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  // The load event may already have fired while the app was being loaded.
  const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {})
  if (document.readyState === "complete") register()
  else window.addEventListener("load", register)
}
