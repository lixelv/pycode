import { Bot, FolderOpen, Globe, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { formatCode } from "@/lib/collab/provider"
import { useI18n } from "@/lib/i18n"
import { CloudError, createProject, deleteProject, listProjects, type ProjectInfo, updateProject } from "@/lib/project/cloud"
import { legacyProject, markLegacyMoved, moveLegacyProject, openProjectStore } from "@/lib/project/project"

const INPUT = "h-8 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"

/** The project of older versions becomes the user's first project here. */
async function moveLegacy(name: string) {
  const old = await legacyProject()
  if (!old) return
  let info: ProjectInfo | null = null
  for (let n = 1; !info; n++) {
    try {
      info = await createProject(n === 1 ? name : `${name} ${n}`)
    } catch (err) {
      if (!(err instanceof CloudError) || err.status !== 409) throw err
    }
  }
  await moveLegacyProject(old, openProjectStore(info.id))
  markLegacyMoved(info.id)
  location.assign(`/p/${info.id}`)
}

export interface ProjectListProps {
  /** Project id -> the tab holding it (only on /mcp-driven). */
  busy?: Record<string, string>
  /** Opens a project; a plain link by default. */
  onOpen?: (id: string) => void
}

/** Every project of this user: create, open, rename, settings, delete. */
export function ProjectList({ busy = {}, onOpen }: ProjectListProps) {
  const { t } = useI18n()
  const [list, setList] = useState<ProjectInfo[] | null>(null)
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    listProjects()
      .then(setList)
      .catch((err: Error) => {
        setList([])
        toast.error(err.message)
      })
  }, [])
  useEffect(() => {
    moveLegacy(t("projects.firstName"))
      .catch((err: Error) => toast.error(err.message))
      .finally(refresh)
  }, [refresh, t])

  const open = (id: string) => (onOpen ? onOpen(id) : location.assign(`/p/${id}`))

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      open((await createProject(trimmed)).id)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const rename = async (p: ProjectInfo, next: string) => {
    setEditing(null)
    const trimmed = next.trim()
    if (!trimmed || trimmed === p.name) return
    await updateProject(p.id, { name: trimmed }).then(refresh, (err: Error) => toast.error(err.message))
  }

  const toggleAsk = (p: ProjectInfo) => updateProject(p.id, { settings: { askName: !p.settings.askName } }).then(refresh, (err: Error) => toast.error(err.message))

  const remove = async (p: ProjectInfo) => {
    if (deleting !== p.id) return setDeleting(p.id)
    setDeleting(null)
    await deleteProject(p.id).then(refresh, (err: Error) => toast.error(err.message))
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <form onSubmit={create} className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t("projects.namePlaceholder")} aria-label={t("projects.namePlaceholder")} className={INPUT + " flex-1"} />
        <Button type="submit" disabled={!name.trim()}>
          <Plus /> {t("projects.create")}
        </Button>
      </form>

      {list === null ? (
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("projects.empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((p) => {
            const heldBy = busy[p.id]
            return (
              <li key={p.id} aria-disabled={!!heldBy} className="flex items-center gap-2 px-3 py-2 text-sm">
                {editing === p.id ? (
                  <input
                    autoFocus
                    defaultValue={p.name}
                    maxLength={100}
                    aria-label={t("projects.rename")}
                    className={INPUT + " flex-1"}
                    onBlur={(e) => void rename(p, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename(p, e.currentTarget.value)
                      if (e.key === "Escape") setEditing(null)
                    }}
                  />
                ) : (
                  <button
                    disabled={!!heldBy}
                    aria-disabled={!!heldBy}
                    onClick={() => open(p.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{p.name}</span>
                    {p.public && <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("projects.public")} />}
                    {heldBy && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Bot className="size-3" /> {t("projects.busy")}
                      </span>
                    )}
                  </button>
                )}
                <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <input type="checkbox" checked={!!p.settings.askName} onChange={() => void toggleAsk(p)} className="size-3.5 accent-foreground" />
                  {t("projects.askName")}
                </label>
                <Button variant="ghost" size="xs" aria-label={t("projects.rename")} title={t("projects.rename")} onClick={() => setEditing(p.id)}>
                  <Pencil />
                </Button>
                <Button variant={deleting === p.id ? "destructive" : "ghost"} size="xs" aria-label={t("projects.delete")} title={t("projects.delete")} onBlur={() => setDeleting(null)} onClick={() => void remove(p)}>
                  <Trash2 /> {deleting === p.id && t("projects.deleteSure")}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const value = code.trim().replace(/^.*\/s\//, "")
          if (value) location.assign(`/s/${value}`)
        }}
        className="flex gap-2"
      >
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("share.codePlaceholder")} spellCheck={false} autoComplete="off" aria-label="Session code or link" className={INPUT + " flex-1 font-mono uppercase placeholder:normal-case"} title={formatCode("ABCD2345")} />
        <Button type="submit" variant="outline" disabled={!code.trim()}>
          {t("share.join")}
        </Button>
      </form>
    </div>
  )
}

/** The page at /. */
export function ProjectListPage() {
  const { t } = useI18n()
  return (
    <div className="flex h-full flex-col items-center gap-6 overflow-auto bg-background p-6 text-foreground">
      <h1 className="pt-8 text-xl font-semibold">{t("projects.title")}</h1>
      <ProjectList />
    </div>
  )
}

/** A project that cannot be opened: deleted, private, or never there. */
export function ProjectMissing() {
  const { t } = useI18n()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background text-foreground">
      <p className="text-sm text-muted-foreground">{t("projects.missing")}</p>
      <Button variant="outline" onClick={() => location.assign("/")}>
        {t("projects.title")}
      </Button>
    </div>
  )
}
