/*
 * The project's objects in S3, as ProjectSaver sees them: keys relative to the
 * project, bytes uncompressed. Each request asks our server for a presigned URL
 * and goes straight to S3; only the browser packs and unpacks (gzip).
 */

export class CloudError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface ProjectInfo {
  id: string
  name: string
  settings: { askName?: boolean }
  public: boolean
  sizeBytes: number
  ownerId: string
  mine: boolean
  createdAt: string
  updatedAt: string
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const answer = (await res.json().catch(() => null)) as { error?: string } | null
    throw new CloudError(answer?.error ?? res.statusText, res.status)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const listProjects = () => request<{ projects: ProjectInfo[] }>("GET", "/api/projects").then((r) => r.projects)
export const getProject = (id: string) => request<ProjectInfo>("GET", `/api/projects/${id}`)
export const createProject = (name: string) => request<ProjectInfo>("POST", "/api/projects", { name })
export const updateProject = (id: string, change: { name?: string; settings?: { askName: boolean } }) => request<ProjectInfo>("PATCH", `/api/projects/${id}`, change)
export const deleteProject = (id: string) => request<void>("DELETE", `/api/projects/${id}`)
export const setProjectPublic = (id: string, isPublic: boolean) => request<ProjectInfo>("POST", `/api/projects/${id}/visibility`, { public: isPublic })
export const copyProject = (id: string) => request<ProjectInfo>("POST", `/api/projects/${id}/copy`, {})

async function pack(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unpack(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export class ProjectCloud {
  private readonly id: string

  constructor(projectId: string) {
    this.id = projectId
  }

  private async url(op: "get" | "put" | "delete", key: string, token?: string, size?: number): Promise<string> {
    const { urls } = await request<{ urls: { key: string; url: string }[] }>("POST", `/api/projects/${this.id}/presign`, {
      saverToken: token,
      ops: [{ op, key, size }],
    })
    return urls[0].url
  }

  /** The object, or null if S3 has none. A 404 from our server (the project is gone) throws. */
  async get(key: string): Promise<Uint8Array | null> {
    const res = await fetch(await this.url("get", key))
    if (res.status === 404) return null
    if (!res.ok) throw new CloudError(`S3 answered ${res.status}`, res.status === 403 ? 502 : res.status)
    return unpack(new Uint8Array(await res.arrayBuffer()))
  }

  async put(key: string, bytes: Uint8Array, token: string): Promise<void> {
    const packed = await pack(bytes)
    const res = await fetch(await this.url("put", key, token, packed.length), { method: "PUT", body: packed as BodyInit })
    if (!res.ok) throw new CloudError(`S3 answered ${res.status}`, res.status === 404 ? 502 : res.status)
  }

  async remove(key: string, token: string): Promise<void> {
    const res = await fetch(await this.url("delete", key, token), { method: "DELETE" })
    if (!res.ok && res.status !== 404) throw new CloudError(`S3 answered ${res.status}`, res.status)
  }

  async keys(): Promise<{ key: string; size: number }[]> {
    return (await request<{ keys: { key: string; size: number }[] }>("GET", `/api/projects/${this.id}/keys`)).keys
  }

  /** Sealed files gave way to new ones: only the server writes under sealed/. */
  async dropSealed(paths: string[], token: string): Promise<void> {
    await request<void>("POST", `/api/projects/${this.id}/sealed/remove`, { saverToken: token, paths })
  }
}
