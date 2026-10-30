import { describe, expect, it } from "vitest"

import { buildPage, scriptPage } from "./web-preview"

const decode = (url: string) => new TextDecoder().decode(Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0)))

describe("buildPage", () => {
  const files = {
    "site/index.html": '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="img/a.png"><script src="app.js"></script><script src="https://cdn.example.com/x.js"></script></body></html>',
    "site/style.css": "body { background: url(img/a.png) }",
    "site/app.js": "console.log('привет')",
    "site/img/a.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  }
  const page = buildPage(files, "site/index.html", "T")

  it("inlines the project's stylesheet, script and image as data URLs", () => {
    const hrefs = [...page.matchAll(/(?:href|src)="(data:[^"]+)"/g)].map((m) => m[1])
    expect(hrefs.some((u) => u.startsWith("data:text/css") && decode(u).includes("url(data:image/png"))).toBe(true)
    expect(hrefs.some((u) => u.startsWith("data:text/javascript") && decode(u) === "console.log('привет')")).toBe(true)
    expect(hrefs.some((u) => u.startsWith("data:image/png"))).toBe(true)
  })

  it("keeps links to the internet", () => {
    expect(page).toContain('src="https://cdn.example.com/x.js"')
  })

  it("adds the console bridge first, tagged with the run's token", () => {
    expect(page.indexOf("postMessage")).toBeLessThan(page.indexOf("data:text/css"))
    expect(page).toContain('"T"')
  })
})

describe("scriptPage", () => {
  it("runs a script file after the bridge", () => {
    const page = scriptPage("alert('</script>')", "T")
    expect(page).toMatch(/data:text\/javascript[^,]*;base64,/)
    expect(page).not.toContain("alert('</script>')")
  })
})
