// A public link in another browser shows no hidden files; a copy runs a sealed test it cannot see.
import { api, appReady, assert, BASE, clickButton, createProject, metas, newPage, openProject, pageText, person, scenario, setFolderRole, storedKeys, textOf, unique, until, writeFile } from "./lib.mjs"

const SECRET = "SECRET_TEST_BODY_123"

await scenario("projects/public-copy", async (browser) => {
  const alice = await person(browser)
  const project = await createProject(alice, unique("Public"))
  const page = await openProject(alice, project.id)
  await writeFile(page, "sum.py", "print(int(input()) + int(input()))")
  const testId = await writeFile(page, "sum.test.py", `# ${SECRET}\ndef test_sum():\n    assert polycode_test.run("1\\n2\\n").strip().endswith("3")\n`, { hidden: true })
  const roleId = await writeFile(page, "students/ivan/work.py", "print('work of ivan')")
  await setFolderRole(page, "students/ivan", "ivan")
  await until("everything saved under its prefix", async () => {
    const keys = await storedKeys(alice, project.id)
    return keys.includes(`hidden/f/${testId}.ybin.gz`) && keys.includes(`private/f/${roleId}.ybin.gz`)
  })

  // Share → Make public.
  await clickButton(page, "Share")
  await clickButton(page, "Make public")
  await until("the project is public", async () => (await api(alice, "GET", `/api/projects/${project.id}`)).json?.public === true)

  // ---- a stranger, in another browser ----
  const bob = await person(browser)
  const requests = []
  const view = await newPage(bob.context)
  view.on("request", (r) => requests.push(r.url()))
  await view.goto(`${BASE}/p/${project.id}`)
  await appReady(view)
  await until("the public text", async () => (await textOf(view, "sum.py"))?.includes("int(input())"))

  const seen = await metas(view)
  assert.deepEqual(Object.keys(seen).sort(), ["sum.py"], "only the public file")
  const text = await pageText(view)
  for (const secret of ["sum.test.py", "students", "work.py", "ivan", SECRET]) assert.ok(!text.includes(secret), `the page shows ${secret}`)
  assert.ok(!requests.some((u) => u.includes(testId) || u.includes(roleId) || u.includes("/hidden/") || u.includes("/private/") || u.includes("/sealed/")), "a request went for a closed object")

  // Asking directly gets 404.
  for (const key of [`hidden/f/${testId}.ybin.gz`, "hidden/manifest.json.gz", `private/f/${roleId}.ybin.gz`, "private/structure.ybin.gz", `sealed/f/${testId}.ybin.gz`]) {
    const res = await api(bob, "POST", `/api/projects/${project.id}/presign`, { ops: [{ op: "get", key }] })
    assert.equal(res.status, 404, `${key}: ${res.status}`)
  }
  const write = await api(bob, "POST", `/api/projects/${project.id}/presign`, { ops: [{ op: "put", key: "public/board.ybin.gz", size: 1 }] })
  assert.ok(write.status >= 400, "a stranger got a write URL")
  assert.equal((await api(bob, "GET", `/api/projects/${project.id}/keys`)).status, 404)

  // Read only: an edit does not reach the owner's copy.
  assert.ok((await storedKeys(alice, project.id)).includes("public/structure.ybin.gz"))

  // ---- Copy to my projects ----
  await clickButton(view, "Copy to my projects")
  await view.waitForFunction((id) => /\/p\/[0-9a-f-]+/.test(location.pathname) && !location.pathname.endsWith(id), { timeout: 30_000 }, project.id)
  await appReady(view)
  const copyId = view.url().split("/p/")[1].split(/[?#]/)[0]
  assert.notEqual(copyId, project.id)

  const copied = await until("the copy's structure", async () => {
    const m = await metas(view)
    return m["sum.test.py"] ? m : null
  })
  assert.equal(copied["sum.test.py"].sealed, true, "the hidden test arrives sealed")
  assert.ok(!Object.keys(copied).some((p) => p.startsWith("students/")), "role folders are not copied")
  assert.equal(await textOf(view, "sum.test.py"), null, "a sealed file has no text in the store")
  assert.ok(!(await pageText(view)).includes("sum.test.py"), "the tree shows the sealed file")

  // In the copy's objects: hidden became sealed, nothing private.
  const keys = await storedKeys(bob, copyId)
  assert.ok(keys.includes(`sealed/f/${testId}.ybin.gz`))
  assert.ok(!keys.some((k) => k.startsWith("hidden/") || k.startsWith("private/f/")), keys.join("\n"))
  const sealedWrite = await api(bob, "POST", `/api/projects/${copyId}/presign`, { ops: [{ op: "delete", key: `sealed/f/${testId}.ybin.gz` }] })
  assert.ok(sealedWrite.status >= 400, "the copy's owner may not delete a sealed file")

  // ---- The sealed test runs ----
  await view.evaluate(() => localStorage.setItem("polycode:lower-layout", ""))
  await clickButton(view, "Check")
  await until("the check's result", async () => (await pageText(view)).includes("test_sum"), 120_000)
  const after = await pageText(view)
  assert.ok(!after.includes(SECRET), "the check showed the test's text")

  // The text stays out of this browser's storage.
  const stored = await view.evaluate(async (secret) => {
    const hits = []
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((done, fail) => {
        const req = indexedDB.open(name)
        req.onsuccess = () => done(req.result)
        req.onerror = () => fail(req.error)
      })
      for (const table of db.objectStoreNames) {
        const all = await new Promise((done) => {
          const req = db.transaction(table).objectStore(table).getAll()
          req.onsuccess = () => done(req.result)
          req.onerror = () => done([])
        })
        const haystack = all.map((v) => (v instanceof Uint8Array ? new TextDecoder("latin1").decode(v) : JSON.stringify(v))).join("")
        if (haystack.includes(secret)) hits.push(`${name}/${table}`)
      }
      db.close()
    }
    return hits
  }, SECRET)
  assert.deepEqual(stored, [], "the sealed text is in IndexedDB")

  // ---- Make private: the link dies at once ----
  await clickButton(page, "Make private")
  await until("the project is private", async () => (await api(bob, "GET", `/api/projects/${project.id}`)).status === 404)
})
