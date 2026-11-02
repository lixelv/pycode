// The agent's work shows in the ordinary tab of the same project, and in a student's.
import { api, appReady, assert, BASE, createProject, issueToken, McpClient, newPage, openProject, person, scenario, storedKeys, textOf, unique, until } from "./lib.mjs"

await scenario("projects/agent-visible", async (browser) => {
  const alice = await person(browser)
  const project = await createProject(alice, unique("Visible"))
  const plain = await openProject(alice, project.id)

  const driven = await newPage(alice.context)
  await driven.goto(`${BASE}/mcp-driven?project=${project.id}`)
  await appReady(driven)

  const client = new McpClient(await issueToken(alice))
  await client.initialize()
  const tab = await until("the tab", async () => (await client.json("list_tabs")).tabs.find((t) => t.project?.id === project.id))
  await client.json("open_project", { project: project.id, tab_id: tab.tab_id })

  // A write through the agent shows in the ordinary tab, through the room.
  const wrote = await client.call("write_file", { path: "agent.py", content: "print('from the agent')" })
  assert.ok(!wrote.isError, JSON.stringify(wrote))
  await until("the agent's file in the ordinary tab", async () => (await textOf(plain, "agent.py")) === "print('from the agent')")

  // And the other way: a person's edit reaches what the agent reads.
  await plain.evaluate(() => {
    const { store } = window.__polycode
    const meta = store.structure.getMap("files").get("agent.py")
    store.doc(`f:${meta.id}`).getText("t").insert(0, "# by hand\n")
  })
  await until("the person's edit in read_file", async () => {
    const read = await client.call("read_file", { path: "agent.py" })
    return read.content[0].text.includes("# by hand")
  })

  // Only one of the two tabs saves, and it does get saved.
  const id = await plain.evaluate(() => window.__polycode.store.structure.getMap("files").get("agent.py").id)
  await until("saved", async () => (await storedKeys(alice, project.id)).includes(`public/f/${id}.ybin.gz`), 15_000)

  // A student who joined by a code sees it too: the agent is seen by the class.
  const session = await api(alice, "POST", `/api/projects/${project.id}/session`)
  assert.ok(session.status < 300, session.text)
  const code = session.json.code
  const bob = await person(browser)
  const student = await newPage(bob.context)
  await student.goto(`${BASE}/s/${code}`)
  await until("the app for the student", () => student.evaluate(() => !!window.__polycode?.store))
  await until("the agent's file for the student", async () => (await textOf(student, "agent.py"))?.includes("print('from the agent')"))
  await client.call("write_file", { path: "second.py", content: "2" })
  await until("the next file for the student", async () => (await textOf(student, "second.py")) === "2")

  // A guest in the room never writes to S3.
  const refused = await api(bob, "POST", `/api/projects/${project.id}/presign`, { ops: [{ op: "put", key: "public/board.ybin.gz", size: 1 }] })
  assert.ok(refused.status >= 400, "a guest got a write URL")
})
