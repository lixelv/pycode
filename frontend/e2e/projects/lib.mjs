// Shared helpers of the end-to-end scenarios of projects in S3.
//
// Each scenario runs alone: `node frontend/e2e/projects/<name>.mjs`, exit code 0 on success.
// Environment:
//   POLYCODE_URL         the running stack (default http://localhost:8081)
//   CHROME_PATH          Chrome (default: the macOS location)
//   S3_TEST_ENDPOINT, S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY, S3_TEST_BUCKET
//                        MinIO, to look at what is stored (delete.mjs)
// Needs puppeteer-core resolvable from here, as in the project's other browser scripts.
import assert from "node:assert/strict"
import { createHash, createHmac, randomUUID } from "node:crypto"

import puppeteer from "puppeteer-core"

export { assert }
export const BASE = (process.env.POLYCODE_URL ?? "http://localhost:8081").replace(/\/$/, "")
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Waits for a condition; fails with what it was waiting for. */
export async function until(what, fn, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

export async function launch() {
  return puppeteer.launch({ executablePath: CHROME, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] })
}

/** A person: a clean browser context with its own cookie. */
export async function person(browser) {
  const context = await browser.createBrowserContext()
  const page = await newPage(context)
  // One request first: parallel first requests get different identity cookies.
  await page.goto(`${BASE}/api/me`)
  const cookies = await context.cookies()
  return { context, cookie: cookies.find((c) => c.name === "pc_uid") }
}

/** The same user in a browser with nothing stored: a new context under the same cookie. */
export async function sameUserCleanBrowser(browser, who) {
  const context = await browser.createBrowserContext()
  await context.setCookie(who.cookie)
  return { context, cookie: who.cookie }
}

export async function newPage(context) {
  const page = await context.newPage()
  await page.evaluateOnNewDocument(() => localStorage.setItem("polycode:e2e", "1"))
  return page
}

/** fetch with the person's cookie, from their browser. */
export async function api(who, method, path, body) {
  const page = await newPage(who.context)
  try {
    await page.goto(`${BASE}/api/me`)
    return await page.evaluate(
      async (m, p, b) => {
        const res = await fetch(p, { method: m, headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined })
        const text = await res.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // not JSON
        }
        return { status: res.status, json, text }
      },
      method,
      path,
      body ?? null,
    )
  } finally {
    await page.close()
  }
}

export async function createProject(who, name) {
  const res = await api(who, "POST", "/api/projects", { name })
  assert.ok(res.status === 200 || res.status === 201, `create project: ${res.status} ${res.text}`)
  return res.json
}

export async function storedKeys(who, id) {
  const res = await api(who, "GET", `/api/projects/${id}/keys`)
  assert.equal(res.status, 200, `keys: ${res.text}`)
  return res.json.keys.map((k) => k.key)
}

/** Opens a project and waits until the app has it. */
export async function openProject(who, id) {
  const page = await newPage(who.context)
  await page.goto(`${BASE}/p/${id}`)
  await appReady(page)
  return page
}

export async function appReady(page) {
  await page.waitForFunction(() => !!window.__polycode?.store, { timeout: 60_000 })
  await page.evaluate(() => window.__polycode.store.ready)
}

/** Writes a file through the app's own store, as an editor would. */
export function writeFile(page, path, content, flags = {}) {
  return page.evaluate(
    (p, c, f) => {
      const { store } = window.__polycode
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      store.structure.getMap("files").set(p, { id, kind: "text", size: c.length, ...f })
      store.doc(`f:${id}`).getText("t").insert(0, c)
      return id
    },
    path,
    content,
    flags,
  )
}

export function setFolderRole(page, folder, role) {
  return page.evaluate((f, r) => window.__polycode.store.structure.getMap("folders").set(f, r), folder, role)
}

/** Path -> meta as the app has them. */
export function metas(page) {
  return page.evaluate(() => window.__polycode.store.structure.getMap("files").toJSON())
}

export function textOf(page, path) {
  return page.evaluate((p) => {
    const { store } = window.__polycode
    const meta = store.structure.getMap("files").get(p)
    return meta && store.has(`f:${meta.id}`) ? store.doc(`f:${meta.id}`).getText("t").toString() : null
  }, path)
}

/** Clicks the first button whose text or label is this (case-insensitive). */
export async function clickButton(page, label, timeout = 15_000) {
  const handle = await page.waitForFunction(
    (wanted) => {
      const norm = (s) => (s ?? "").trim().toLowerCase()
      return [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].find((b) => norm(b.textContent) === norm(wanted) || norm(b.getAttribute("aria-label")) === norm(wanted) || norm(b.getAttribute("title")) === norm(wanted))
    },
    { timeout },
    label,
  )
  await handle.asElement().click()
}

export const pageText = (page) => page.evaluate(() => document.body.innerText)

// ---- a real MCP client ------------------------------------------------------------------

export class McpClient {
  constructor(token) {
    this.token = token
    this.session = null
    this.nextId = 1
  }

  async request(method, params = {}) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${this.token}` }
    if (this.session) headers["Mcp-Session-Id"] = this.session
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }) })
    assert.equal(res.status, 200, `${method}: HTTP ${res.status}`)
    const session = res.headers.get("Mcp-Session-Id")
    const answer = await res.json()
    assert.ok(!answer.error, `${method}: ${JSON.stringify(answer.error)}`)
    return { result: answer.result, session }
  }

  async initialize() {
    const { result, session } = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } })
    assert.ok(session, "initialize gave no Mcp-Session-Id")
    this.session = session
    return result
  }

  /** The tool's whole answer. */
  async call(name, args = {}) {
    const { result } = await this.request("tools/call", { name, arguments: args })
    return result
  }

  /** The parsed first text block; fails on a tool error. */
  async json(name, args = {}) {
    const result = await this.call(name, args)
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
    return JSON.parse(result.content[0].text)
  }
}

/** A token for this person, as the Reissue button gets it. */
export async function issueToken(who) {
  const res = await api(who, "POST", "/api/mcp/token")
  assert.equal(res.status, 200, `token: ${res.text}`)
  return res.json.token
}

// ---- MinIO, directly: a signed ListObjectsV2 ---------------------------------------------

export async function listS3(prefix) {
  const endpoint = process.env.S3_TEST_ENDPOINT
  assert.ok(endpoint, "S3_TEST_ENDPOINT is not set")
  const access = process.env.S3_TEST_ACCESS_KEY
  const secret = process.env.S3_TEST_SECRET_KEY
  const bucket = process.env.S3_TEST_BUCKET
  const host = endpoint.replace(/^https?:\/\//, "")
  const region = "us-east-1"
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")
  const day = now.slice(0, 8)
  const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`
  const empty = createHash("sha256").update("").digest("hex")
  const headers = `host:${host}\nx-amz-content-sha256:${empty}\nx-amz-date:${now}\n`
  const signed = "host;x-amz-content-sha256;x-amz-date"
  const canonical = ["GET", `/${bucket}`, query, headers, signed, empty].join("\n")
  const scope = `${day}/${region}/s3/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", now, scope, createHash("sha256").update(canonical).digest("hex")].join("\n")
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest()
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request")
  const signature = createHmac("sha256", key).update(toSign).digest("hex")
  const res = await fetch(`http://${host}/${bucket}?${query}`, {
    headers: {
      "x-amz-content-sha256": empty,
      "x-amz-date": now,
      Authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
  })
  const xml = await res.text()
  assert.equal(res.status, 200, xml)
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])
}

// ---- running a scenario ------------------------------------------------------------------

export const unique = (name) => `${name} ${randomUUID().slice(0, 8)}`

export async function scenario(name, fn) {
  const browser = await launch()
  try {
    await fn(browser)
    console.log(`ok ${name}`)
  } catch (err) {
    console.error(`FAILED ${name}\n`, err)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}
