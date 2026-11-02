import { CloudError, getProject, ProjectCloud, type ProjectInfo } from "./cloud"
import { finishLegacyMove, openProjectStore, openViewStore } from "./project"
import { loadPublic, ProjectSaver } from "./saver"

/** What this page shows: one page load holds one project. A guest's page has none. */
export type PageProject = { kind: "own"; info: ProjectInfo; cloud: ProjectCloud; saver: ProjectSaver } | { kind: "view"; info: ProjectInfo; cloud: ProjectCloud }

async function eraseLocalCopy(id: string) {
  const databases = (await indexedDB.databases?.().catch(() => [])) ?? []
  for (const { name } of databases) if (name?.startsWith(`polycode:${id}:`)) indexedDB.deleteDatabase(name)
}

/** Opens a project for this page; rejects with CloudError 404 if it may not be seen. */
export async function openPage(id: string): Promise<PageProject> {
  const cloud = new ProjectCloud(id)
  const info = await getProject(id).catch(async (err) => {
    if (err instanceof CloudError) {
      // Deleted (from another device, say): a copy left here must not outlive it.
      if (err.status === 404) await eraseLocalCopy(id)
      throw err
    }
    // No answer at all: the local copy may be there, and it is ours to work on.
    return { id, name: "", settings: {}, public: false, sizeBytes: 0, ownerId: "", mine: true, createdAt: "", updatedAt: "" } satisfies ProjectInfo
  })
  if (!info.mine) {
    const store = openViewStore()
    await loadPublic(store, cloud)
    return { kind: "view", info, cloud }
  }
  const store = openProjectStore(id)
  await store.ready
  const saver = new ProjectSaver(id, store, cloud)
  await saver.load()
  const off = saver.on(() => {
    if (saver.status !== "saved" || !saver.stored) return
    off()
    void finishLegacyMove(id)
  })
  return { kind: "own", info, cloud, saver }
}
