import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  EdgeLabelRenderer,
  ReactFlow,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react"
import { Crosshair } from "lucide-react"
import { memo, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import type { Edge } from "@xyflow/react"

import type { AstLoc } from "@/lib/ast"
import {
  DASHED,
  EDGE_COLORS,
  GROUP_COLORS,
  KIND_META,
  kindTag,
  layoutFlow,
  roundedPath,
  type FlowGraphNode,
  type FlowNodeData,
  type FlowResponse,
  type FlowEdgeKind,
  type FrameData,
  type RoutedEdgeData,
} from "@/lib/flow"
import { useI18n, type MessageKey } from "@/lib/i18n"
import type { Theme } from "@/lib/storage"
import { cn } from "@/lib/utils"

const hidden = "!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"

function Handles() {
  return (
    <>
      <Handle id="top" type="target" position={Position.Top} className={hidden} />
      <Handle id="bottom" type="source" position={Position.Bottom} className={hidden} />
      <Handle id="right-out" type="source" position={Position.Right} className={hidden} style={{ top: "65%" }} />
      <Handle id="right-in" type="target" position={Position.Right} className={hidden} style={{ top: "35%" }} />
      <Handle id="left-in" type="target" position={Position.Left} className={hidden} />
    </>
  )
}

const StepNode = memo(function StepNode({ data, selected }: NodeProps<Extract<FlowGraphNode, { type: "step" }>>) {
  const meta = KIND_META[data.kind]
  if (data.kind === "start" || data.kind === "end") {
    return (
      <div
        className={cn(
          "flex h-10 items-center justify-center rounded-full bg-foreground px-4 font-mono text-xs font-semibold text-background",
          selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      >
        <Handles />
        <span className="truncate">{data.label}</span>
      </div>
    )
  }
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border bg-card text-card-foreground transition-colors",
        selected ? "border-ring ring-2 ring-ring/30" : "border-border hover:border-muted-foreground/60",
      )}
    >
      <Handles />
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: meta.color }} />
      <div className="flex items-center gap-2 px-3.5 pt-2 text-[10px] font-medium tracking-wider uppercase" style={{ color: meta.color }}>
        <span>{kindTag(data.kind)}</span>
        <span className="ml-auto font-mono text-muted-foreground normal-case">
          #{data.step}
          {data.loc ? ` · line ${data.loc.line}` : ""}
        </span>
      </div>
      <div className="truncate px-3.5 pt-1 font-mono text-[12.5px] font-semibold">{data.label}</div>
      <div className="px-3.5 pt-0.5 pb-2.5 text-[11.5px] leading-4 text-muted-foreground">{data.caption}</div>
    </div>
  )
})

const FrameNode = memo(function FrameNode({ data }: NodeProps<Extract<FlowGraphNode, { type: "frame" }>>) {
  const { title, kind } = data as FrameData
  const color = GROUP_COLORS[kind]
  return (
    <div
      className={cn("size-full rounded-xl border border-dashed", kind === "class" ? "bg-muted/20" : "bg-muted/40")}
      style={{ borderColor: color }}
    >
      <div className="px-4 pt-2.5 font-mono text-xs font-semibold" style={{ color }}>
        {title}
      </div>
    </div>
  )
})

/** Draws the route dagre computed around the cards, with an arrowhead. */
const RoutedEdge = memo(function RoutedEdge({ id, data, label }: EdgeProps<Edge<RoutedEdgeData>>) {
  const points = data?.points ?? []
  if (points.length < 2) return null
  const end = points[points.length - 1]
  const prev = points[points.length - 2]
  const angle = Math.atan2(end.y - prev.y, end.x - prev.x)
  const head = (a: number) => `${end.x - 9 * Math.cos(angle + a)},${end.y - 9 * Math.sin(angle + a)}`
  return (
    <>
      <path
        id={id}
        d={roundedPath(points)}
        fill="none"
        stroke={data!.color}
        strokeWidth={1.5}
        strokeDasharray={data!.dash}
        className="react-flow__edge-path"
      />
      <path d={`M${end.x},${end.y}L${head(0.45)}L${head(-0.45)}Z`} fill={data!.color} />
      {label && data!.labelAt && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded bg-background px-1.5 py-px font-mono text-[11px] font-semibold"
            style={{ transform: `translate(-50%, -50%) translate(${data!.labelAt.x}px, ${data!.labelAt.y}px)`, color: data!.color, zIndex: 30 }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const nodeTypes = { step: StepNode, frame: FrameNode }
const edgeTypes = { routed: RoutedEdge }

const LEGEND: [FlowEdgeKind, MessageKey][] = [
  ["next", "flow.next"],
  ["yes", "flow.yes"],
  ["no", "flow.no"],
  ["repeat", "flow.repeat"],
  ["call", "flow.call"],
  ["create", "flow.create"],
  ["inherit", "flow.inherit"],
]

export function FlowCanvas({
  data,
  theme,
  onReveal,
}: {
  data: FlowResponse
  theme: Theme
  onReveal: (loc: AstLoc) => void
}) {
  const { t } = useI18n()
  const [graph, setGraph] = useState<Awaited<ReturnType<typeof layoutFlow>> | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    layoutFlow(data)
      .then((g) => !cancelled && setGraph(g))
      .catch((err: Error) => !cancelled && setLayoutError(err.message))
    return () => {
      cancelled = true
    }
  }, [data])
  const nodes = useMemo(() => graph?.nodes ?? [], [graph])
  const edges = graph?.edges ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = nodes.find((n) => n.id === selectedId && n.type === "step")?.data as FlowNodeData | undefined
  const { fitView } = useReactFlow()

  useEffect(() => {
    // Start at the top of the program at a readable zoom.
    const first = nodes.filter((n) => n.type === "step" && !(n.data as FlowNodeData).group).slice(0, 6)
    const frame = requestAnimationFrame(() => fitView({ nodes: first.length ? first : nodes, padding: 0.3, minZoom: 0.7, maxZoom: 1 }))
    return () => cancelAnimationFrame(frame)
  }, [nodes, fitView])

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-h-0 flex-1">
        {layoutError && (
          <div className="absolute inset-x-0 top-4 z-10 mx-auto w-fit rounded-md border border-border bg-card px-3 py-2 text-xs text-destructive">
            Could not lay the chart out: {layoutError}
          </div>
        )}
        <ReactFlow
          nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme}
          nodesDraggable={false}
          nodesConnectable={false}
          minZoom={0.1}
          maxZoom={2}
          onNodeClick={(_, node) => node.type === "step" && setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>

      <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-card md:flex">
        {selected ? (
          <div className="flex flex-col gap-4 overflow-auto p-4">
            <div>
              <div className="text-[11px] tracking-wider uppercase" style={{ color: KIND_META[selected.kind].color }}>
                {kindTag(selected.kind)}
                {selected.step ? ` · ${t("flow.step", { n: selected.step })}` : ""}
              </div>
              <pre className="mt-2 rounded-md border border-border bg-background p-2.5 font-mono text-xs whitespace-pre-wrap">
                {selected.label}
              </pre>
            </div>
            <p className="text-sm leading-relaxed">{selected.caption}</p>
            {selected.group && (
              <p className="text-xs text-muted-foreground">
                {t("flow.inside", { name: selected.group })}
              </p>
            )}
            {selected.loc && (
              <Button variant="outline" size="sm" onClick={() => onReveal(selected.loc!)}>
                <Crosshair /> {t("flow.reveal", { n: selected.loc.line })}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4 text-sm text-muted-foreground">
            <p>{t("flow.intro")}</p>
            <div className="space-y-2">
              {LEGEND.map(([kind, label]) => (
                <div key={kind} className="flex items-center gap-2.5 text-xs">
                  <svg width="28" height="8" aria-hidden>
                    <line
                      x1="0"
                      y1="4"
                      x2="28"
                      y2="4"
                      stroke={EDGE_COLORS[kind]}
                      strokeWidth="2"
                      strokeDasharray={DASHED[kind]}
                    />
                  </svg>
                  {t(label)}
                </div>
              ))}
            </div>
            <p className="text-xs">
              {t("flow.frames")}
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}
