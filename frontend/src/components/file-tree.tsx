import {
  ChevronRight,
  Pencil,
  Download,
  File,
  FileCode2,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Peer } from "@/hooks/use-collab"
import { useI18n } from "@/lib/i18n"
import { allDirs, cleanPath, dirsOf, exists, languageOf, metasOf, nameOf, parentOf } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"
import { cn } from "@/lib/utils"

interface FileTreeProps {
  store: ProjectStore
  active: string
  readOnly: boolean
  peers: Peer[]
  onOpen: (path: string) => void
  onCreate: (path: string, kind: "file" | "dir") => void
  onDelete: (path: string, kind: "file" | "dir") => void
  onRename: (from: string, to: string) => void
  onDownload: () => void
  onUpload: (file: File) => void
  onReset: () => void
  /** In a session only the owner may reset the project. */
  canReset: boolean
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
  if (lang === "python") return <FileCode2 className={cn(cls, "text-chart-1")} />
  if (lang === "json") return <FileJson className={cn(cls, "text-chart-5")} />
  if (lang === "yaml") return <FileText className={cn(cls, "text-chart-4")} />
  if (lang === "markdown") return <FileText className={cn(cls, "text-chart-2")} />
  return <File className={cn(cls, "text-muted-foreground")} />
}

export function FileTree(props: FileTreeProps) {
  const { store, active, readOnly, peers, onOpen, onCreate, onDelete, onRename, onDownload, onUpload, onReset, canReset } = props
  const { t } = useI18n()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [, setVersion] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<{ kind: "file" | "dir"; parent: string } | null>(null)
  const [selectedDir, setSelectedDir] = useState("")
  const upload = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    const files = metasOf(store)
    const dirs = dirsOf(store)
    files.observe(bump)
    dirs.observe(bump)
    return () => {
      files.unobserve(bump)
      dirs.unobserve(bump)
    }
  }, [store])

  const files = [...metasOf(store).keys()]
  const tree = buildTree(files, allDirs(store))
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
                  )}
                  style={pad}
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
              <ContextMenuItem onSelect={() => setRenaming(node.path)}>
                <Pencil /> {t("tree.rename")}
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
                )}
                style={{ paddingLeft: 8 + depth * 12 + 16 }}
                onClick={() => {
                  setSelectedDir(parentOf(node.path))
                  onOpen(node.path)
                }}
              >
                <FileIcon path={node.path} />
                <span className="truncate font-mono text-[12.5px]">{node.name}</span>
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
            <ContextMenuItem onSelect={() => setRenaming(node.path)}>
              <Pencil /> {t("tree.rename")}
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
    <aside className="flex h-full w-full flex-col bg-card">
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
          <ul className="min-h-0 flex-1 overflow-auto p-1.5" onClick={(e) => e.target === e.currentTarget && setSelectedDir("")}>
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
