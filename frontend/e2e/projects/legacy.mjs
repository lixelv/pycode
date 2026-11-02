// The one project of older versions, in this browser's IndexedDB, becomes the user's first project.
import * as Y from "yjs"

import { assert, BASE, metas, newPage, person, scenario, sleep, storedKeys, textOf, until, api } from "./lib.mjs"

const FILE_ID = "legacyfile000001"

function legacyDocs() {
  const structure = new Y.Doc()
  structure.getMap("files").set("old.py", { id: FILE_ID, kind: "text", size: 12 })
  structure.getMap("state").set("setUp", true)
  const text = new Y.Doc()
  text.getText("t").insert(0, "print('old')")
  return { "polycode:structure": [...Y.encodeStateAsUpdate(structure)], [`polycode:f:${FILE_ID}`]: [...Y.encodeStateAsUpdate(text)] }
}

await scenario("projects/legacy", async (browser) => {
  const alice = await person(browser)
  const seed = await newPage(alice.context)
  await seed.goto(`${BASE}/api/me`)
  // y-indexeddb's own layout: an "updates" store of Uint8Array, and "custom".
  await seed.evaluate(async (docs) => {
    for (const [name, update] of Object.entries(docs)) {
      await new Promise((done, fail) => {
        const req = indexedDB.open(name)
        req.onupgradeneeded = () => {
          req.result.createObjectStore("updates", { autoIncrement: true })
          req.result.createObjectStore("custom")
        }
        req.onerror = () => fail(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction("updates", "readwrite")
          tx.objectStore("updates").add(new Uint8Array(update))
          tx.oncomplete = () => {
            req.result.close()
            done()
          }
        }
      })
    }
  }, legacyDocs())
  await seed.close()

  const page = await newPage(alice.context)
  await page.goto(BASE)
  await until("the move to a project", () => page.url().includes("/p/"), 30_000)
  const id = page.url().split("/p/")[1]
  await until("the app", () => page.evaluate(() => !!window.__polycode?.store))
  await until("the old file", async () => (await textOf(page, "old.py")) === "print('old')")
  assert.deepEqual(Object.keys(await metas(page)), ["old.py"])
  await until("the old file in S3", async () => (await storedKeys(alice, id)).includes(`public/f/${FILE_ID}.ybin.gz`) && (await storedKeys(alice, id)).includes("private/structure.ybin.gz"))

  const databases = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  await until("the old databases gone", async () => !(await databases()).includes("polycode:structure"))

  // Once only: back at the list, no second project.
  await page.goto(BASE)
  await sleep(2000)
  assert.ok(!page.url().includes("/p/"), "moved again")
  const list = await api(alice, "GET", "/api/projects")
  assert.equal(list.json.projects.length, 1)
})
