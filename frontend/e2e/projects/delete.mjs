// Deleting a project: S3 is emptied, a tab still open stops writing, IndexedDB does not bring it back (review focus 5).
import { api, assert, BASE, createProject, listS3, newPage, openProject, person, scenario, sleep, storedKeys, unique, until, writeFile } from "./lib.mjs"

const databases = (page, id) => page.evaluate(async (needle) => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.includes(needle)), id)

await scenario("projects/delete", async (browser) => {
  const alice = await person(browser)
  const project = await createProject(alice, unique("Delete"))
  const prefix = `projects/${project.id}/`
  const page = await openProject(alice, project.id)
  const id = await writeFile(page, "main.py", "print(1)")
  await until("the file in S3", async () => (await storedKeys(alice, project.id)).includes(`public/f/${id}.ybin.gz`), 15_000)
  assert.ok((await listS3(prefix)).length > 0, "MinIO should hold the project")
  assert.ok((await databases(page, project.id)).length > 0, "IndexedDB is per project")

  const res = await api(alice, "DELETE", `/api/projects/${project.id}`)
  assert.ok(res.status < 300, res.text)

  // At once: nothing in S3, 404 for everyone.
  assert.deepEqual(await listS3(prefix), [], "objects left after the delete")
  assert.equal((await api(alice, "GET", `/api/projects/${project.id}`)).status, 404)
  assert.equal((await api(alice, "POST", `/api/projects/${project.id}/presign`, { ops: [{ op: "get", key: "public/structure.ybin.gz" }] })).status, 404)

  // The tab still open goes on editing: it gets 404, stops, and writes nothing.
  const failures = []
  page.on("response", (r) => {
    if (r.url().includes(`/projects/${project.id}/`) && r.request().method() === "PUT" && r.ok()) failures.push(r.url())
  })
  await page.evaluate(() => {
    const { store } = window.__polycode
    const meta = store.structure.getMap("files").get("main.py")
    if (meta) store.doc(`f:${meta.id}`).getText("t").insert(0, "# late edit\n")
  })
  await sleep(6000)
  assert.deepEqual(failures, [], "a PUT reached S3 after the delete")
  assert.deepEqual(await listS3(prefix), [], "the open tab brought the project back")

  // Reopening: the owner's IndexedDB is erased, the project does not come back.
  await page.close()
  const again = await newPage(alice.context)
  await again.goto(`${BASE}/p/${project.id}`)
  await until("the local copy erased", async () => (await databases(again, project.id)).length === 0)
  await sleep(3000)
  assert.deepEqual(await listS3(prefix), [], "reopening brought the project back")
  assert.equal((await api(alice, "GET", `/api/projects/${project.id}`)).status, 404)
})
