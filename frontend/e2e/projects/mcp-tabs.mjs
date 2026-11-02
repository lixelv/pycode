// Two /mcp-driven tabs; a reload keeps the tab id and project, a duplicate gets a new id (review focus 4).
import { appReady, assert, BASE, createProject, issueToken, McpClient, newPage, pageText, person, scenario, sleep, unique, until } from "./lib.mjs"

/** Where a tab keeps its id: whichever sessionStorage value list_tabs knows. */
const sessionValues = (page) => page.evaluate(() => Object.values(sessionStorage))
const sessionDump = (page) => page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))

await scenario("projects/mcp-tabs", async (browser) => {
  const alice = await person(browser)
  const a = await createProject(alice, unique("Tabs A"))
  const b = await createProject(alice, unique("Tabs B"))
  const client = new McpClient(await issueToken(alice))
  await client.initialize()

  const tabs = async () => (await client.json("list_tabs")).tabs
  const tabOf = async (id) => (await tabs()).find((t) => t.project?.id === id)

  // Tab one on project A.
  const one = await newPage(alice.context)
  await one.goto(`${BASE}/mcp-driven?project=${a.id}`)
  await appReady(one)
  const tabA = await until("tab one in list_tabs", () => tabOf(a.id))
  assert.ok((await sessionValues(one)).includes(tabA.tab_id), "the tab id is in sessionStorage")

  // The page shows the address and the token block.
  const text = await pageText(one)
  assert.ok(text.includes("/mcp"), "the address of the MCP endpoint")

  // Tab two asks for the same project: it is busy, so the list shows, the project marked and inactive.
  const two = await newPage(alice.context)
  await two.goto(`${BASE}/mcp-driven?project=${a.id}`)
  await until("the list in tab two", async () => (await pageText(two)).includes(b.name))
  assert.equal((await tabs()).filter((t) => t.project?.id === a.id).length, 1, "one tab per project")
  const disabled = await two.evaluate((name) => {
    const row = [...document.querySelectorAll("button, a, [role=button], li")].find((el) => el.textContent.includes(name))
    return row ? row.disabled === true || row.getAttribute("aria-disabled") === "true" : null
  }, a.name)
  assert.equal(disabled, true, "a project open elsewhere is inactive in the list")

  // Tab two opens project B from its list.
  await two.evaluate((name) => {
    const row = [...document.querySelectorAll("button, a, [role=button]")].find((el) => el.textContent.includes(name) && !el.disabled)
    row.click()
  }, b.name)
  const tabB = await until("tab two on project B", () => tabOf(b.id))
  assert.notEqual(tabB.tab_id, tabA.tab_id)

  // A reload keeps the id and reopens the project.
  await one.reload()
  await appReady(one)
  const reloaded = await until("tab one after the reload", () => tabOf(a.id))
  assert.equal(reloaded.tab_id, tabA.tab_id, "the id survives a reload")
  assert.ok(one.url().includes(a.id) || (await sessionDump(one)).includes(a.id), "the project survives a reload")

  // A duplicate starts with a copy of sessionStorage; it must not push the original out.
  const dump = await one.evaluate(() => Object.entries(sessionStorage))
  const dup = await alice.context.newPage()
  await dup.evaluateOnNewDocument((entries) => {
    localStorage.setItem("polycode:e2e", "1")
    if (sessionStorage.getItem("__copied")) return
    sessionStorage.setItem("__copied", "1")
    for (const [k, v] of entries) sessionStorage.setItem(k, v)
  }, dump)
  await dup.goto(`${BASE}/mcp-driven`)
  await until("the duplicate's own tab", async () => (await tabs()).length === 3, 15_000)
  await sleep(1000)
  const all = await tabs()
  assert.equal(new Set(all.map((t) => t.tab_id)).size, 3, "three tabs, three ids")
  assert.equal((await tabOf(a.id)).tab_id, tabA.tab_id, "the original keeps its id and project")
  assert.ok(!(await sessionValues(dup)).includes(tabA.tab_id), "the duplicate took a new id")
  assert.ok(!(await tabs()).some((t) => t.tab_id !== tabA.tab_id && t.project?.id === a.id), "the duplicate did not take the project")
  // And the original still works.
  await client.json("open_project", { project: a.id, tab_id: tabA.tab_id })
  const overview = await client.json("project_overview")
  assert.equal(overview.tab_id, tabA.tab_id)

  // Out to the list: the project is free again.
  await dup.close()
  await two.close()
  await until("closed tabs leave the registry", async () => (await tabs()).length === 1)

  // A plain tab of the same project is not a /mcp-driven tab.
  const plain = await newPage(alice.context)
  await plain.goto(`${BASE}/p/${a.id}`)
  await appReady(plain)
  await sleep(500)
  assert.equal((await tabs()).length, 1, "an ordinary tab does not listen for MCP")

  // The robot button leads to /mcp-driven?project=<id> in a new tab.
  const opened = new Promise((done) => alice.context.once("targetcreated", (target) => done(target)))
  await plain.evaluate(() => {
    const robot = document.querySelector('[aria-label*="MCP" i], [title*="MCP" i], [aria-label*="agent" i], [title*="agent" i]')
    robot?.click()
  })
  const target = await Promise.race([opened, sleep(10_000).then(() => null)])
  assert.ok(target, "no new tab from the robot button")
  assert.ok(target.url().includes("/mcp-driven") && target.url().includes(a.id), target.url())
})
