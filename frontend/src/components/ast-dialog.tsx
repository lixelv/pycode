import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { AlertTriangle, Crosshair, Loader2 } from "lucide-react"
import { memo, useEffect, useMemo, useState } from "react"

import { FlowCanvas } from "@/components/flow-view"
import type { FlowResponse } from "@/lib/flow"
import { callTool } from "@/lib/python/tools-client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  CATEGORY_COLORS,
  layout,
  sourceSegment,
  type AstCategory,
  type AstLoc,
  type AstResponse,
  type FlowNode,
} from "@/lib/ast"
import type { Theme } from "@/lib/storage"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

interface AstDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  code: string
  theme: Theme
  onReveal: (loc: AstLoc) => void
}

const LEGEND: [AstCategory, string][] = [
  ["definition", "Definitions"],
  ["statement", "Statements"],
  ["expression", "Expressions"],
  ["literal", "Literals"],
]

const AstNode = memo(function AstNode({ data, selected }: NodeProps<FlowNode>) {
  const fields = Object.entries(data.fields)
  return (
    <div
      className={cn(
        "rounded-md border bg-card font-mono text-[12px] text-card-foreground shadow-xs transition-colors",
        selected ? "border-ring ring-2 ring-ring/30" : "border-border hover:border-muted-foreground/50",
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-muted-foreground" />
      <div className="flex items-center gap-2 px-3 py-1.5 font-semibold">
        <span className="size-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLORS[data.category] }} />
        <span className="truncate">{data.type}</span>
      </div>
      {fields.length > 0 && (
        <div className="border-t border-border px-3 py-1">
          {fields.map(([k, v]) => (
            <div key={k} className="truncate leading-[18px]">
              <span className="text-muted-foreground">{k}</span> <span className="text-muted-foreground/60">=</span>{" "}
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-muted-foreground" />
    </div>
  )
})

const nodeTypes = { ast: AstNode }

function TreeCanvas({ data, theme, code, onReveal }: { data: AstResponse; theme: Theme; code: string; onReveal: (loc: AstLoc) => void }) {
  const { nodes, edges } = useMemo(() => layout(data), [data])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = nodes.find((n) => n.id === selectedId)?.data
  const { fitView } = useReactFlow()

  useEffect(() => {
    // Big trees: start on the top levels at a readable zoom, not a tiny overview.
    const top = nodes.length > 30 ? nodes.filter((n) => n.data.depth <= 2) : nodes
    const frame = requestAnimationFrame(() => fitView({ nodes: top, padding: 0.15, minZoom: 0.55, maxZoom: 1.1 }))
    return () => cancelAnimationFrame(frame)
  }, [nodes, fitView])


  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          minZoom={0.05}
          maxZoom={2}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ style: { strokeWidth: 1 } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>

      <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-card md:flex">
        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
            <div>
              <div className="text-[11px] tracking-wider text-muted-foreground uppercase">Node</div>
              <div className="mt-1 flex items-center gap-2 font-mono text-sm font-semibold">
                <span className="size-2 rounded-full" style={{ background: CATEGORY_COLORS[selected.category] }} />
                {selected.type}
              </div>
              {selected.loc && (
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  Ln {selected.loc.line}:{selected.loc.col} → {selected.loc.endLine}:{selected.loc.endCol}
                </div>
              )}
            </div>
            {Object.keys(selected.fields).length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">Fields</div>
                <dl className="divide-y divide-border rounded-md border border-border font-mono text-xs">
                  {Object.entries(selected.fields).map(([k, v]) => (
                    <div key={k} className="flex gap-3 px-2.5 py-1.5">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="ml-auto truncate text-right" title={v}>
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {selected.loc && (
              <div>
                <div className="mb-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">Source</div>
                <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs whitespace-pre-wrap">
                  {sourceSegment(code, selected.loc)}
                </pre>
                <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => onReveal(selected.loc!)}>
                  <Crosshair /> Reveal in editor
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-4 p-4 text-sm text-muted-foreground">
            <p>Click a node to inspect its fields and the source it was parsed from.</p>
            <div className="space-y-1.5">
              {LEGEND.map(([cat, label]) => (
                <div key={cat} className="flex items-center gap-2 text-xs">
                  <span className="size-2 rounded-full" style={{ background: CATEGORY_COLORS[cat] }} />
                  {label}
                </div>
              ))}
            </div>
            <p className="text-xs">Edges are labelled with the field that holds the child, e.g. <code className="font-mono">body[0]</code>.</p>
          </div>
        )}
      </aside>
    </div>
  )
}

type Mode = "flow" | "tree"

export function AstDialog({ open, onOpenChange, code, theme, onReveal }: AstDialogProps) {
  const { lang, t } = useI18n()
  const [mode, setMode] = useState<Mode>("flow")
  const [data, setData] = useState<{ mode: Mode; body: AstResponse | FlowResponse } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setFailure(null)
    callTool<AstResponse | FlowResponse>(mode === "flow" ? "flow" : "ast", { code, lang })
      .then((body) => !cancelled && setData({ mode, body }))
      .catch((err: Error) => !cancelled && setFailure(err.message || "Python failed to analyse the code."))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, code, mode, lang])

  const body = data?.mode === mode ? data.body : null
  const count = body?.nodes?.length ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[96vw]">
        <DialogHeader className="flex-row items-center gap-3 border-b border-border px-5 py-3 text-left">
          <DialogTitle className="sr-only">Program structure</DialogTitle>
          <DialogDescription className="sr-only">How the program runs step by step, or the syntax tree Python builds.</DialogDescription>
          <div role="tablist" className="inline-flex rounded-md border border-border bg-muted p-0.5">
            {(
              [
                ["flow", t("tree.flowchart")],
                ["tree", t("tree.syntax")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
                  mode === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {body?.ok && (
            <Badge variant="outline" className="font-mono text-[11px] font-normal">
              {mode === "flow" ? t("tree.steps", { n: count }) : t("tree.nodes", { n: count })}
              {body.truncated ? " (truncated)" : ""}
            </Badge>
          )}
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {mode === "flow" ? t("tree.order") : "ast.parse(source)"}
          </span>
        </DialogHeader>

        {loading && !body ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> {t("tree.analysing")}
          </div>
        ) : failure ? (
          <EmptyState title={t("tree.failed")} detail={failure} />
        ) : body && !body.ok ? (
          <EmptyState
            title={t("tree.syntaxError")}
            detail={`${body.error?.message ?? "Invalid syntax"}${body.error?.line ? ` (${t("tree.line", { n: body.error.line })})` : ""}`}
          />
        ) : body ? (
          <ReactFlowProvider key={mode}>
            {mode === "flow" ? (
              <FlowCanvas data={body as FlowResponse} theme={theme} onReveal={onReveal} />
            ) : (
              <TreeCanvas data={body as AstResponse} theme={theme} code={code} onReveal={onReveal} />
            )}
          </ReactFlowProvider>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium">{title}</div>
      <div className="max-w-md font-mono text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}
