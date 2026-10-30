import type { Peer } from "@/hooks/use-collab"

/**
 * y-monaco marks each remote selection with classes ending in the peer's
 * Yjs client id; this stylesheet colours them per person. Names next to
 * the cursors are optional (the colours say who is who).
 */
export function RemoteCursorStyles({ peers, labels }: { peers: Peer[]; labels: boolean }) {
  const css = peers
    .filter((p) => !p.isMe)
    .map(({ clientId: id, user }) => {
      const label = JSON.stringify(user.name)
      return `
.yRemoteSelection-${id} { background-color: ${user.color}40; }
.yRemoteSelectionHead-${id} { border-left: 2px solid ${user.color}; }
${labels ? `.yRemoteSelectionHead-${id}::after { content: ${label}; background: ${user.color}; }` : ""}`
    })
    .join("\n")
  return <style>{BASE + css}</style>
}

const BASE = `
.yRemoteSelectionHead {
  position: absolute;
  height: 100%;
  box-sizing: border-box;
  z-index: 5;
}
.yRemoteSelectionHead::after {
  position: absolute;
  top: -1.35em;
  left: -2px;
  padding: 0 5px;
  border-radius: 4px 4px 4px 0;
  color: #000;
  font: 600 10px/1.5 'Geist Variable', system-ui, sans-serif;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0.95;
}
`
