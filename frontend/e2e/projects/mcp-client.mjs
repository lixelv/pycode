// A real MCP client over HTTP with two Mcp-Session-Id sessions, each on a tab of its own.
import { appReady, assert, BASE, createProject, issueToken, McpClient, newPage, person, scenario, textOf, unique, until } from "./lib.mjs"

await scenario("projects/mcp-client", async (browser) => {
  const alice = await person(browser)
  const token = await issueToken(alice)

  // No token, wrong token: 401.
  for (const auth of [undefined, "Bearer wrong"]) {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    })
    assert.equal(res.status, 401, `Authorization ${auth}`)
  }
  // The old per-session route is gone.
  const old = await fetch(`${BASE}/s/ABCDEF/mcp`, { method: "POST", body: "{}" })
  assert.ok(old.status === 404 || old.status === 405, `old route: ${old.status}`)

  const first = new McpClient(token)
  const second = new McpClient(token)
  const init = await first.initialize()
  await second.initialize()
  assert.notEqual(first.session, second.session, "two sessions, two ids")
  assert.ok(init.instructions.includes("list_tabs"), "the instructions start from list_tabs")

  // No tabs yet.
  const none = await first.call("project_overview")
  assert.ok(none.isError && none.content[0].text.includes("/mcp-driven"), JSON.stringify(none))

  // Projects can be created without a browser.
  const nameA = unique("Client A")
  const nameB = unique("Client B")
  const a = await first.json("create_project", { project: nameA })
  const b = await first.json("create_project", { project: nameB })
  const c = await createProject(alice, unique("Client C"))
  const listed = (await first.json("list_projects")).projects
  for (const p of [a, b, c]) assert.ok(listed.some((x) => x.id === p.id && x.tab_id === null), `listed without a tab: ${p.id}`)

  // Two tabs, empty; the agent opens a project in each.
  const pageOne = await newPage(alice.context)
  await pageOne.goto(`${BASE}/mcp-driven`)
  const pageTwo = await newPage(alice.context)
  await pageTwo.goto(`${BASE}/mcp-driven`)
  const tabs = await until("two tabs", async () => {
    const list = (await first.json("list_tabs")).tabs
    return list.length === 2 ? list : null
  })
  const [t1, t2] = tabs.map((t) => t.tab_id)
  assert.equal(tabs[0].project, null)

  // Not chosen yet.
  const unchosen = await first.call("project_overview")
  assert.ok(unchosen.isError && unchosen.content[0].text.includes("open_project"), JSON.stringify(unchosen))

  await first.json("open_project", { project: nameA, tab_id: t1 })
  await second.json("open_project", { project: b.id, tab_id: t2 })
  // Switching reloads the pages.
  await Promise.all([appReady(pageOne), appReady(pageTwo)])

  // The second session may not take what the first holds.
  const busy = await second.call("open_project", { project: a.id, tab_id: t2 })
  assert.ok(busy.isError && busy.content[0].text.includes(t1), JSON.stringify(busy))

  // Each session works in its own tab, and every answer says which.
  const wroteA = await first.json("project_overview")
  assert.equal(wroteA.tab_id, t1)
  assert.deepEqual({ id: wroteA.project.id, name: wroteA.project.name }, { id: a.id, name: nameA })
  const wroteB = await second.json("project_overview")
  assert.equal(wroteB.tab_id, t2)
  assert.equal(wroteB.project.id, b.id)

  await first.call("write_file", { path: "from_first.py", content: "1" })
  await second.call("write_file", { path: "from_second.py", content: "2" })
  await until("the first file in the first tab", async () => (await textOf(pageOne, "from_first.py")) === "1")
  await until("the second file in the second tab", async () => (await textOf(pageTwo, "from_second.py")) === "2")
  assert.equal(await textOf(pageOne, "from_second.py"), null, "a write reached the wrong project")
  assert.equal(await textOf(pageTwo, "from_first.py"), null, "a write reached the wrong project")

  // A text file's answer keeps its text, with the stamp beside it.
  const read = await first.call("read_file", { path: "from_first.py" })
  assert.ok(!read.isError)
  assert.equal(read.content.length, 2)
  assert.equal(read.content[0].text.includes("1"), true)
  assert.equal(JSON.parse(read.content[1].text).tab_id, t1)

  // Switching a tab to another project: its session follows, the old project is free.
  await second.json("open_project", { project: c.id, tab_id: t2 })
  await appReady(pageTwo)
  assert.equal((await second.json("project_overview")).project.id, c.id)
  const after = (await first.json("list_projects")).projects
  assert.equal(after.find((p) => p.id === b.id).tab_id, null, "the old project was released")
  assert.equal(after.find((p) => p.id === c.id).tab_id, t2)

  // Closing a tab: the session's current tab goes.
  await pageTwo.close()
  await until("the tab leaves", async () => (await first.json("list_tabs")).tabs.length === 1)
  const closed = await second.call("project_overview")
  assert.ok(closed.isError && closed.content[0].text.includes("open_project"), JSON.stringify(closed))

  // Deleting a project: the tab stays, without one.
  await first.json("delete_project", { project: a.id })
  await until("the tab without a project", async () => (await first.json("list_tabs")).tabs[0].project === null)
  const gone = await first.call("project_overview")
  assert.ok(gone.isError, JSON.stringify(gone))

  // Reissuing kills the old token.
  const fresh = await issueToken(alice)
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  })
  assert.equal(res.status, 401)
  const again = new McpClient(fresh)
  await again.initialize()
})
