// Creating a project, saving it, and opening it in a clean browser under the same cookie.
import { appReady, assert, BASE, createProject, newPage, openProject, pageText, person, sameUserCleanBrowser, scenario, sleep, storedKeys, textOf, unique, until, writeFile } from "./lib.mjs"

await scenario("projects/persist", async (browser) => {
  const alice = await person(browser)
  const name = unique("Persist")
  const project = await createProject(alice, name)

  // The list on / shows it.
  const list = await newPage(alice.context)
  await list.goto(`${BASE}/`)
  await until("the project in the list", async () => (await pageText(list)).includes(name))
  await list.close()

  const page = await openProject(alice, project.id)
  const id = await writeFile(page, "main.py", "print('saved in s3')")

  // Saved about 2 seconds after the last edit, not before.
  await sleep(500)
  assert.ok(!(await storedKeys(alice, project.id)).includes(`public/f/${id}.ybin.gz`), "written before the 2 second debounce")
  await until("the file in S3", async () => (await storedKeys(alice, project.id)).includes(`public/f/${id}.ybin.gz`), 15_000)
  assert.ok((await storedKeys(alice, project.id)).includes("private/structure.ybin.gz"))
  assert.ok((await storedKeys(alice, project.id)).includes("public/structure.ybin.gz"))
  assert.ok(!(await storedKeys(alice, project.id)).some((k) => k.includes("runtime")), "runtime is not stored")

  // Clean browser, same cookie: nothing in IndexedDB, everything comes from S3.
  const again = await sameUserCleanBrowser(browser, alice)
  const fresh = await newPage(again.context)
  await fresh.goto(`${BASE}/p/${project.id}`)
  await appReady(fresh)
  assert.equal(await until("the text from S3", () => textOf(fresh, "main.py")), "print('saved in s3')")

  // An edit on the second device reaches the first through a reload, and neither loses anything.
  await fresh.evaluate(() => {
    const { store } = window.__polycode
    const meta = store.structure.getMap("files").get("main.py")
    store.doc(`f:${meta.id}`).getText("t").insert(0, "# second device\n")
  })
  await sleep(3500)
  await page.reload()
  await appReady(page)
  await until("the merged text", async () => (await textOf(page, "main.py")) === "# second device\nprint('saved in s3')")

  // A stranger gets 404 for a private project: no copy button, nothing of it.
  const bob = await person(browser)
  const strangers = await newPage(bob.context)
  const res = await strangers.goto(`${BASE}/api/projects/${project.id}`)
  assert.equal(res.status(), 404)

  // The status in the footer comes back to saved. (Sanity of the visible state.)
  assert.ok(!(await pageText(page)).toLowerCase().includes("not saved"), "the footer says not saved after a save")
})
