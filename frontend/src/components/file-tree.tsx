import {
  ChevronRight,
  Copy,
  Pencil,
  Download,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus,
  FileText,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  Lock,
  LockOpen,
  Eye,
  Users,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { AccessView } from "@/hooks/use-access"
import { ADMINS_ONLY, isReserved } from "@/lib/project/access"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Peer } from "@/hooks/use-collab"
import { useI18n } from "@/lib/i18n"
import {
  allDirs,
  cleanPath,
  exists,
  foldersOf,
  languageOf,
  metasOf,
  moveTarget,
  nameOf,
  parentOf,
  rolesOf,
  setFlag,
  setFolderRole,
} from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"
import { cn } from "@/lib/utils"

interface FileTreeProps {
  store: ProjectStore
  active: string
  /** Not an admin: cannot change the tree. */
  readOnly: boolean
  access: AccessView
  peers: Peer[]
  /** Files being dragged over the page, and the folder they would land in. */
  drop?: { dragging: boolean; target: string }
  /** Paths just added: highlighted for a moment. */
  flash?: Set<string>
  onOpen: (path: string) => void
  onCreate: (path: string, kind: "file" | "dir") => void
  onDelete: (path: string, kind: "file" | "dir") => void
  onRename: (from: string, to: string) => void
  onDuplicate: (path: string) => void
  onDownload: () => void
  onUpload: (file: File) => void
  onReset: () => void
  /** In a session only the owner may reset the project. */
  canReset: boolean
}

/** Our own rows in a drag; not "Files", so useFileDrop leaves it alone. */
const ROW_DRAG = "application/x-polycode-path"
/** How long a drag rests on a closed folder before it opens. */
const OPEN_ON_HOVER_MS = 600

/** The folder under a drag: a folder row, a file row's folder, or the root. */
function folderOfRow(target: EventTarget): string {
  const row = (target as Element).closest<HTMLElement>("[data-path]")
  if (!row) return ""
  return row.dataset.kind === "dir" ? (row.dataset.path ?? "") : parentOf(row.dataset.path ?? "")
}

interface Node {
  path: string
  name: string
  kind: "file" | "dir"
  children: Node[]
}

function buildTree(files: string[], dirs: string[]): Node[] {
  const root: Node = { path: "", name: "", kind: "dir", children: [] }
  const byPath = new Map<string, Node>([["", root]])
  const ensureDir = (path: string): Node => {
    let node = byPath.get(path)
    if (node) return node
    node = { path, name: nameOf(path), kind: "dir", children: [] }
    byPath.set(path, node)
    ensureDir(parentOf(path)).children.push(node)
    return node
  }
  dirs.forEach(ensureDir)
  for (const path of files) ensureDir(parentOf(path)).children.push({ path, name: nameOf(path), kind: "file", children: [] })
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

function FileIcon({ path }: { path: string }) {
  const lang = languageOf(path)
  const cls = "size-3.5 shrink-0"
  if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path)) return <FileImage className={cn(cls, "text-chart-3")} />
  if (lang === "python") return <FileCode2 className={cn(cls, "text-chart-1")} />
  if (lang === "json") return <FileJson className={cn(cls, "text-chart-5")} />
  if (lang === "yaml") return <FileText className={cn(cls, "text-chart-4")} />
  if (lang === "markdown") return <FileText className={cn(cls, "text-chart-2")} />
  if (lang === "html" || lang === "css" || lang === "javascript") return <FileCode2 className={cn(cls, lang === "javascript" ? "text-chart-4" : lang === "css" ? "text-chart-2" : "text-chart-5")} />
  return <File className={cn(cls, "text-muted-foreground")} />
}

export function FileTree(props: FileTreeProps) {
  const { store, active, readOnly, access, peers, drop, flash, onOpen, onCreate, onDelete, onRename, onDuplicate, onDownload, onUpload, onReset, canReset } = props
  const { t } = useI18n()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [, setVersion] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<{ kind: "file" | "dir"; parent: string } | null>(null)
  const [selectedDir, setSelectedDir] = useState("")
  const upload = useRef<HTMLInputElement>(null)
  // The row being dragged, and the folder it would land in (null: nowhere it can).
  const dragged = useRef<string | null>(null)
  const [moveInto, setMoveInto] = useState<string | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openFolder = useRef<string | null>(null)

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    store.structure.on("update", bump)
    return () => store.structure.off("update", bump)
  }, [store])

  // Only what we may see: a folder is shown when a file inside it would be.
  const metas = metasOf(store)
  const folders = foldersOf(store).toJSON() as Record<string, string>
  const roles = Object.keys(rolesOf(store).toJSON())
  const files = [...metas.keys()].filter((p) => access.can(p) !== "none")
  const tree = buildTree(files, allDirs(store).filter((d) => access.can(`${d}/_`) !== "none"))
  // Where the others are: file -> colours.
  const presence = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const p of peers) if (!p.isMe && p.file) map.set(p.file, [...(map.get(p.file) ?? []), p.user.color])
    return map
  }, [peers])

  const startCreate = (kind: "file" | "dir", inDir?: string) => {
    const parent = inDir ?? selectedDir
    if (parent) setCollapsed((c) => new Set([...c].filter((x) => x !== parent)))
    setCreating({ kind, parent })
  }

  const endDrag = () => {
    dragged.current = null
    openFolder.current = null
    clearTimeout(openTimer.current)
    setMoveInto(null)
  }

  const rowDrag = (path: string) =>
    readOnly
      ? {}
      : {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData(ROW_DRAG, path)
            e.dataTransfer.effectAllowed = "move"
            dragged.current = path
          },
          onDragEnd: endDrag,
        }

  const dragOver = (e: DragEvent) => {
    if (!dragged.current) return
    const folder = folderOfRow(e.target)
    const result = moveTarget(store, dragged.current, folder)
    const can = "to" in result || result.error === "exists"
    setMoveInto(can ? folder : null)
    // Without preventDefault the browser refuses the drop.
    if (can) e.preventDefault()
    if (openFolder.current !== folder) {
      openFolder.current = folder
      clearTimeout(openTimer.current)
      if (folder && collapsed.has(folder)) {
        openTimer.current = setTimeout(() => setCollapsed((c) => new Set([...c].filter((x) => x !== folder))), OPEN_ON_HOVER_MS)
      }
    }
  }

  const dropRow = (e: DragEvent) => {
    const from = dragged.current
    if (!from) return
    e.preventDefault()
    const result = moveTarget(store, from, folderOfRow(e.target))
    endDrag()
    if ("to" in result) onRename(from, result.to)
    else if (result.error === "exists") toast.error(t("tree.err.exists"))
  }

  const renderNode = (node: Node, depth: number) => {
    const pad = { paddingLeft: 8 + depth * 12 }
    if (node.kind === "dir") {
      const open = !collapsed.has(node.path)
      return (
        <li key={node.path}>
          <ContextMenu>
            <ContextMenuTrigger asChild disabled={readOnly} onContextMenu={(e) => e.stopPropagation()}>
              {renaming === node.path ? (
                <RenameRow depth={depth} kind="dir" name={node.name} onCancel={() => setRenaming(null)} onSubmit={(name) => submitRename(node.path, name)} />
              ) : (
                <div
                  className={cn(
                    "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    selectedDir === node.path && "text-foreground",
                    ((drop?.dragging && drop.target === node.path) || moveInto === node.path) && "bg-primary/10 text-foreground ring-1 ring-primary/50",
                    flash?.has(node.path) && "animate-flash",
                  )}
                  data-path={node.path}
                  data-kind="dir"
                  style={pad}
                  {...rowDrag(node.path)}
                  onClick={() => {
                    setSelectedDir(node.path)
                    setCollapsed((c) => {
                      const next = new Set(c)
                      if (next.has(node.path)) next.delete(node.path)
                      else next.add(node.path)
                      return next
                    })
                  }}
                >
                  <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
                  {open ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
                  <span className="truncate">{node.name}</span>
                  {folders[node.path] && (
                    <span title={t("tree.access")} className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-1.5 font-mono text-[10px]">
                      <Users className="size-2.5" /> {folders[node.path] === ADMINS_ONLY ? t("tree.adminsOnly") : folders[node.path]}
                    </span>
                  )}
                  {!readOnly && <DeleteButton label={`${t("tree.delete")} ${node.name}`} onClick={() => onDelete(node.path, "dir")} />}
                </div>
              )}
            </ContextMenuTrigger>
            <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
              <ContextMenuItem onSelect={() => startCreate("file", node.path)}>
                <FilePlus /> {t("tree.newFile")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => startCreate("dir", node.path)}>
                <FolderPlus /> {t("tree.newFolder")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Users /> {t("tree.access")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuRadioGroup value={folders[node.path] ?? ""} onValueChange={(v) => setFolderRole(store, node.path, v || null)}>
                    <ContextMenuRadioItem value="">{t("tree.public")}</ContextMenuRadioItem>
                    <ContextMenuRadioItem value={ADMINS_ONLY}>{t("tree.adminsOnly")}</ContextMenuRadioItem>
                    {roles.map((r) => (
                      <ContextMenuRadioItem key={r} value={r} className="font-mono text-xs">
                        {r}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem onSelect={() => setRenaming(node.path)}>
                <Pencil /> {t("tree.rename")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onDuplicate(node.path)}>
                <Copy /> {t("tree.duplicate")}
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onSelect={() => onDelete(node.path, "dir")}>
                <Trash2 /> {t("tree.delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {open && (
            <ul>
              {creating?.parent === node.path && <CreateRow depth={depth + 1} {...createProps()} />}
              {node.children.map((c) => renderNode(c, depth + 1))}
            </ul>
          )}
        </li>
      )
    }
    const isActive = node.path === active
    return (
      <li key={node.path}>
        <ContextMenu>
          <ContextMenuTrigger asChild disabled={readOnly} onContextMenu={(e) => e.stopPropagation()}>
            {renaming === node.path ? (
              <RenameRow depth={depth} kind="file" name={node.name} onCancel={() => setRenaming(null)} onSubmit={(name) => submitRename(node.path, name)} />
            ) : (
              <div
                className={cn(
                  "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm hover:bg-accent",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  flash?.has(node.path) && "animate-flash",
                )}
                data-path={node.path}
                data-kind="file"
                {...rowDrag(node.path)}
                style={{ paddingLeft: 8 + depth * 12 + 16 }}
                onClick={() => {
                  setSelectedDir(parentOf(node.path))
                  onOpen(node.path)
                }}
              >
                <FileIcon path={node.path} />
                <span className="truncate font-mono text-[12.5px]">{node.name}</span>
                {metas.get(node.path)?.protected && (
                  <Lock aria-label={t("tree.protected")} className="size-3 shrink-0 text-muted-foreground">
                    <title>{t("tree.protected")}</title>
                  </Lock>
                )}
                {metas.get(node.path)?.hidden && (
                  <EyeOff aria-label={t("tree.hidden")} className="size-3 shrink-0 text-muted-foreground">
                    <title>{t("tree.hidden")}</title>
                  </EyeOff>
                )}
                <span className="ml-auto flex -space-x-1 pl-1">
                  {(presence.get(node.path) ?? []).slice(0, 3).map((color, i) => (
                    <span key={i} className="size-2 rounded-full border border-background" style={{ background: color }} />
                  ))}
                </span>
                {!readOnly && <DeleteButton label={`${t("tree.delete")} ${node.name}`} onClick={() => onDelete(node.path, "file")} />}
              </div>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
            {metas.get(node.path)?.protected ? (
              <ContextMenuItem onSelect={() => setFlag(store, node.path, "protected", false)}>
                <LockOpen /> {t("tree.unprotect")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => setFlag(store, node.path, "protected", true)}>
                <Lock /> {t("tree.protect")}
              </ContextMenuItem>
            )}
            {metas.get(node.path)?.hidden ? (
              <ContextMenuItem onSelect={() => setFlag(store, node.path, "hidden", false)}>
                <Eye /> {t("tree.show")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => setFlag(store, node.path, "hidden", true)}>
                <EyeOff /> {t("tree.hide")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setRenaming(node.path)}>
              <Pencil /> {t("tree.rename")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onDuplicate(node.path)}>
              <Copy /> {t("tree.duplicate")}
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(node.path, "file")}>
              <Trash2 /> {t("tree.delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </li>
    )
  }

  /** Validates a new name next to the old path; returns an error message or null. */
  const validate = (parent: string, name: string, current?: string): { path?: string; error?: string } => {
    const path = cleanPath(parent ? `${parent}/${name}` : name)
    if (!path) return { error: t("tree.err.dots") }
    if (isReserved(path)) return { error: t("tree.err.reserved") }
    if (path !== current && exists(store, path)) return { error: t("tree.err.exists") }
    return { path }
  }

  const submitRename = (from: string, name: string): string | null => {
    const { path, error } = validate(parentOf(from), name, from)
    if (error) return error
    if (path && path !== from) onRename(from, path)
    setRenaming(null)
    return null
  }

  const createProps = () => ({
    kind: creating!.kind,
    parent: creating!.parent,
    onCancel: () => setCreating(null),
    onSubmit: (name: string) => {
      const { path, error } = validate(creating!.parent, name)
      if (error || !path) return error ?? null
      onCreate(path, creating!.kind)
      setCreating(null)
      return null
    },
  })

  return (
    <aside className="relative flex h-full w-full flex-col bg-card">
      {drop?.dragging && (
        <div className="pointer-events-none absolute inset-1.5 z-20 flex animate-in items-end justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/5 pb-6 duration-200 fade-in-0 zoom-in-95">
          <div className="flex items-center gap-2 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg">
            <Upload className="size-3.5 animate-bounce" />
            {drop.target ? t("tree.dropInto", { folder: drop.target }) : t("tree.drop")}
          </div>
        </div>
      )}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border pr-1.5 pl-3">
        <span className="mr-auto text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{t("tree.project")}</span>
        <TreeAction label={t("tree.newFile")} disabled={readOnly} onClick={() => startCreate("file")}>
          <FilePlus />
        </TreeAction>
        <TreeAction label={t("tree.newFolder")} disabled={readOnly} onClick={() => startCreate("dir")}>
          <FolderPlus />
        </TreeAction>
        <TreeAction label={t("tree.download")} onClick={onDownload}>
          <Download />
        </TreeAction>
        <TreeAction label={t("tree.upload")} disabled={readOnly} onClick={() => upload.current?.click()}>
          <Upload />
        </TreeAction>
        <TreeAction label={canReset ? t("tree.reset") : t("tree.resetOwnerOnly")} disabled={!canReset} onClick={onReset}>
          <RotateCcw />
        </TreeAction>
        <input
          ref={upload}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUpload(file)
            e.target.value = ""
          }}
        />
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={readOnly}>
          <ul
            className={cn("min-h-0 flex-1 overflow-auto rounded-md p-1.5", moveInto === "" && "ring-1 ring-primary/50 ring-inset")}
            onClick={(e) => e.target === e.currentTarget && setSelectedDir("")}
            onDragOver={dragOver}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null) && setMoveInto(null)}
            onDrop={dropRow}
          >
            {creating?.parent === "" && <CreateRow depth={0} {...createProps()} />}
            {tree.map((n) => renderNode(n, 0))}
          </ul>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenuItem onSelect={() => startCreate("file", "")}>
            <FilePlus /> {t("tree.newFile")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => startCreate("dir", "")}>
            <FolderPlus /> {t("tree.newFolder")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </aside>
  )
}

function TreeAction({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} className="text-muted-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="ml-1 hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground group-hover:flex hover:text-destructive"
    >
      <Trash2 className="size-3" />
    </button>
  )
}

function CreateRow({
  depth,
  kind,
  onSubmit,
  onCancel,
}: {
  depth: number
  kind: "file" | "dir"
  parent: string
  onSubmit: (name: string) => string | null
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const input = useFocusAfterMenu()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return onCancel()
    setError(onSubmit(name.trim()))
  }
  return (
    <li style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 pr-1">
      <form onSubmit={submit} className="flex items-center gap-1.5">
        {kind === "dir" ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />}
        <input
          ref={input.ref}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onBlur={() => input.focused.current && !name.trim() && onCancel()}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          placeholder={kind === "dir" ? t("tree.placeholder.dir") : t("tree.placeholder.file")}
          spellCheck={false}
          aria-label={kind === "dir" ? t("tree.newFolderName") : t("tree.newFileName")}
          className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 font-mono text-xs outline-none"
        />
      </form>
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </li>
  )
}

function RenameRow({
  depth,
  kind,
  name: initialName,
  onSubmit,
  onCancel,
}: {
  depth: number
  kind: "file" | "dir"
  name: string
  onSubmit: (name: string) => string | null
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(initialName)
  const [error, setError] = useState<string | null>(null)
  // Select the name without its extension, like VS Code.
  const dot = kind === "file" ? initialName.lastIndexOf(".") : -1
  const input = useFocusAfterMenu([0, dot > 0 ? dot : initialName.length])
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!name.trim() || name.trim() === initialName) return onCancel()
    setError(onSubmit(name.trim()))
  }
  return (
    <div style={{ paddingLeft: 8 + depth * 12 + (kind === "file" ? 16 : 0) }} className="py-0.5 pr-1">
      <form onSubmit={submit} className="flex items-center gap-1.5">
        {kind === "dir" ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <Pencil className="size-3.5 shrink-0 text-muted-foreground" />}
        <input
          ref={input.ref}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onBlur={() => input.focused.current && submit()}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          spellCheck={false}
          aria-label={t("tree.renameTo")}
          className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 font-mono text-xs outline-none"
        />
      </form>
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

/**
 * Focuses an inline input once the context menu that opened it has closed
 * (an open menu keeps focus inside itself, so autoFocus would be lost and the
 * blur would cancel the row). `focused` tells blur handlers it was focused.
 */
function useFocusAfterMenu(select?: [number, number]) {
  const ref = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  const [start, end] = select ?? [-1, -1]
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        if (start >= 0) el.setSelectionRange(start, end)
        focused.current = true
      }),
    )
    return () => cancelAnimationFrame(frame)
  }, [start, end])
  return { ref, focused }
}
