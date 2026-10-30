import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import type * as Y from "yjs"

import type { ProjectStore } from "@/lib/project/store"

import { colorFor, nameFor } from "./identity"

export type Role = "owner" | "editor" | "viewer"
export type SessionMode = "read_only" | "read_write"

export interface SessionInfo {
  id: string
  code: string
  ownerId: string
  mode: SessionMode
}

export interface PeerUser {
  id: string
  name: string
  color: string
}

/** Messages for whoever is running the program (addressed by Yjs client id). */
export type Signal =
  | { type: "stdin"; to: number; text: string }
  | { type: "eof"; to: number }
  | { type: "stop"; to: number }

export type ProviderStatus = "connecting" | "synced" | "offline" | "ended"
export type LinkMode = "direct" | "relay"

interface PeerInfo {
  peer: number
  userId: string
  role: Role
}

type Control =
  | { type: "welcome"; you: PeerInfo; session: SessionInfo; peers?: PeerInfo[] }
  | { type: "join" | "leave"; peer: PeerInfo }
  | { type: "signal"; from: number; data: SignalData }
  | { type: "reset"; from: number }
  | { type: "error"; error: string }
  | { type: "ended" }

type SignalData = { sdp: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit }

type Events = {
  status: (status: ProviderStatus) => void
  /** The owner reset the session's project (announced by the server). */
  reset: () => void
  signal: (signal: Signal) => void
  links: () => void
}

// Data messages between peers (first byte).
const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_SIGNAL = 2
// Chunk framing on the wire: [CHUNK][id u32][index u16][count u16][part] or [WHOLE][message].
const WHOLE = 0
const CHUNK = 1
const CHUNK_SIZE = 60_000

const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]

/**
 * One other member. Data flows through the server relay from the first
 * moment; a WebRTC data channel is negotiated alongside and takes over once
 * open. If it drops, traffic goes back to the relay while a new direct
 * connection is attempted (with backoff) — so nothing ever waits on WebRTC.
 */
class Link {
  pc: RTCPeerConnection | null = null
  channel: RTCDataChannel | null = null
  mode: LinkMode = "relay"
  clients = new Set<number>() // awareness client ids seen through this link
  private chunks = new Map<number, { parts: Uint8Array[]; got: number }>()
  private nextChunk = 1
  private timer: number | undefined
  private attempt = 0
  private closed = false
  private provider: CollabProvider
  readonly info: PeerInfo

  constructor(provider: CollabProvider, info: PeerInfo, initiator: boolean) {
    this.provider = provider
    this.info = info
    // Usable right away through the relay.
    queueMicrotask(() => provider.onLinkReady(this))
    this.connect(initiator)
  }

  /** Retries are started by one side only (the lower peer id) to avoid offer collisions. */
  private get leads() {
    return this.provider.peerId < this.info.peer
  }

  private connect(initiator: boolean) {
    if (this.closed) return
    this.pc?.close()
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc
    // Both sides create the same negotiated channel: no extra round trip.
    const channel = pc.createDataChannel("yjs", { negotiated: true, id: 0, ordered: true })
    channel.binaryType = "arraybuffer"
    this.channel = channel
    channel.onopen = () => {
      if (this.pc !== pc) return
      this.attempt = 0
      window.clearTimeout(this.timer)
      this.setMode("direct")
    }
    channel.onclose = () => this.lost(pc)
    channel.onmessage = (e) => this.receiveFrame(new Uint8Array(e.data as ArrayBuffer))
    pc.onicecandidate = (e) => {
      if (e.candidate && this.pc === pc) this.provider.sendSignal(this.info.peer, { candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") this.lost(pc)
    }
    if (initiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.provider.sendSignal(this.info.peer, { sdp: pc.localDescription!.toJSON() }))
        .catch(() => this.lost(pc))
    }
    // ICE can hang in "checking" forever (some NATs, VPNs): give up and retry later.
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      if (this.pc === pc && this.mode !== "direct") this.lost(pc)
    }, 10_000)
  }

  /** The direct channel is gone (or never came): use the relay and try again later. */
  private lost(pc: RTCPeerConnection) {
    if (this.pc !== pc || this.closed) return
    this.setMode("relay")
    window.clearTimeout(this.timer)
    if (!this.leads) return // the other side starts the next attempt
    const delay = Math.min(30_000, 2000 * 2 ** this.attempt++)
    this.timer = window.setTimeout(() => this.connect(true), delay)
  }

  async onSignal(data: SignalData) {
    try {
      if ("sdp" in data) {
        // A new offer means the other side started a fresh attempt.
        if (data.sdp.type === "offer" && this.pc && (this.pc.remoteDescription || this.pc.signalingState !== "stable")) {
          this.connect(false)
        } else if (data.sdp.type === "offer" && !this.pc) {
          this.connect(false)
        }
        const pc = this.pc!
        await pc.setRemoteDescription(data.sdp)
        if (data.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer())
          this.provider.sendSignal(this.info.peer, { sdp: pc.localDescription!.toJSON() })
        }
      } else if (data.candidate && this.pc?.remoteDescription) {
        await this.pc.addIceCandidate(data.candidate)
      }
    } catch {
      // A failed negotiation just leaves the pair on the relay.
    }
  }

  private setMode(mode: LinkMode) {
    if (this.mode === mode) return
    this.mode = mode
    this.provider.emitLinks()
  }

  /** Sends one message, split into chunks that fit a data channel. */
  send(message: Uint8Array) {
    const frames: Uint8Array[] = []
    if (message.length + 1 <= CHUNK_SIZE) {
      const f = new Uint8Array(message.length + 1)
      f[0] = WHOLE
      f.set(message, 1)
      frames.push(f)
    } else {
      const id = this.nextChunk++
      const count = Math.ceil(message.length / CHUNK_SIZE)
      for (let i = 0; i < count; i++) {
        const part = message.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        const f = new Uint8Array(part.length + 9)
        const view = new DataView(f.buffer)
        f[0] = CHUNK
        view.setUint32(1, id)
        view.setUint16(5, i)
        view.setUint16(7, count)
        f.set(part, 9)
        frames.push(f)
      }
    }
    for (const f of frames) {
      if (this.mode === "direct" && this.channel?.readyState === "open") this.channel.send(f.buffer as ArrayBuffer)
      else this.provider.sendRelay(this.info.peer, f)
    }
  }

  receiveFrame(frame: Uint8Array) {
    if (frame[0] === WHOLE) {
      this.provider.onMessage(this, frame.subarray(1))
      return
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const id = view.getUint32(1)
    const index = view.getUint16(5)
    const count = view.getUint16(7)
    let entry = this.chunks.get(id)
    if (!entry) {
      entry = { parts: new Array(count), got: 0 }
      this.chunks.set(id, entry)
    }
    if (!entry.parts[index]) {
      entry.parts[index] = frame.slice(9)
      entry.got++
    }
    if (entry.got === count) {
      this.chunks.delete(id)
      const total = entry.parts.reduce((n, p) => n + p.length, 0)
      const message = new Uint8Array(total)
      let offset = 0
      for (const p of entry.parts) {
        message.set(p, offset)
        offset += p.length
      }
      this.provider.onMessage(this, message)
    }
  }

  close() {
    this.closed = true
    window.clearTimeout(this.timer)
    this.channel?.close()
    this.pc?.close()
  }
}

/**
 * Shares a Y.Doc in a live session. Members connect to each other directly
 * (WebRTC data channels); the server forwards signaling, relays data for
 * pairs that cannot connect directly, and tells everyone each member's role
 * — which receivers enforce: changes from viewers are ignored.
 */
export class CollabProvider {
  readonly store: ProjectStore
  readonly awareness: Awareness
  role: Role = "viewer"
  /** Our member number in the room (from the server). */
  peerId = 0
  session: SessionInfo
  status: ProviderStatus = "connecting"
  readonly links = new Map<number, Link>()

  private ws: WebSocket | null = null
  private listeners: { [K in keyof Events]: Set<Events[K]> } = { status: new Set(), reset: new Set(), signal: new Set(), links: new Set() }
  private retry = 0
  private retryTimer: number | undefined
  private closed = false
  private readonly detach: (() => void)[] = []
  private readonly onAwareness: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void

  constructor(session: SessionInfo, me: string, store: ProjectStore) {
    this.session = session
    this.store = store
    this.awareness = new Awareness(store.structure)
    this.awareness.setLocalStateField("user", { id: me, name: nameFor(me), color: colorFor(me) } satisfies PeerUser)

    for (const id of store.ids()) this.watch(id, store.doc(id))
    this.detach.push(
      store.onDoc((id, doc) => {
        this.watch(id, doc)
        // A new document (a file someone added): ask everyone for its content.
        this.broadcast(this.syncStep1(id, doc))
      }),
    )
    this.onAwareness = ({ added, updated, removed }, origin) => {
      if (origin instanceof Link) return
      this.broadcast(this.awarenessMessage([...added, ...updated, ...removed]))
    }
    this.awareness.on("update", this.onAwareness)
    window.addEventListener("beforeunload", this.onUnload)
    this.connect()
  }

  /** Our Yjs client id (the same in every document of the project). */
  get clientID() {
    return this.store.clientID
  }

  get code() {
    return this.session.code
  }

  get canWrite() {
    return this.role !== "viewer"
  }

  on<K extends keyof Events>(event: K, fn: Events[K]) {
    this.listeners[event].add(fn)
    return () => {
      this.listeners[event].delete(fn)
    }
  }

  /** Who is connected how (for the members list). */
  linkModes(): Map<number, LinkMode> {
    const out = new Map<number, LinkMode>()
    this.links.forEach((link) => link.clients.forEach((c) => out.set(c, link.mode)))
    return out
  }

  signal(signal: Signal) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SIGNAL)
    encoding.writeVarString(enc, JSON.stringify(signal))
    this.broadcast(encoding.toUint8Array(enc))
  }

  destroy() {
    this.closed = true
    window.clearTimeout(this.retryTimer)
    window.removeEventListener("beforeunload", this.onUnload)
    removeAwarenessStates(this.awareness, [this.clientID], "leave")
    this.links.forEach((l) => l.close())
    this.links.clear()
    this.ws?.close()
    this.detach.forEach((fn) => fn())
    this.awareness.off("update", this.onAwareness)
    this.awareness.destroy()
  }

  // ---- server connection (signaling + relay) -------------------------------

  private connect() {
    if (this.closed) return
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${this.session.code}/ws`)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    this.setStatus("connecting")

    ws.onmessage = (event) => {
      if (typeof event.data === "string") this.onControl(JSON.parse(event.data) as Control)
      else {
        const data = new Uint8Array(event.data as ArrayBuffer)
        const from = new DataView(data.buffer).getUint32(0)
        this.links.get(from)?.receiveFrame(data.subarray(4))
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.links.forEach((l) => l.close())
      this.links.clear()
      this.emitLinks()
      if (this.closed || this.status === "ended") return
      this.setStatus("offline")
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.clientID)
      removeAwarenessStates(this.awareness, others, "offline")
      this.retryTimer = window.setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++))
    }
  }

  private onControl(msg: Control) {
    switch (msg.type) {
      case "welcome":
        this.role = msg.you.role
        this.peerId = msg.you.peer
        this.session = msg.session
        this.retry = 0
        // The newcomer opens a connection to everyone already here.
        for (const info of msg.peers ?? []) this.addLink(info, true)
        this.setStatus("synced")
        break
      case "join":
        this.addLink(msg.peer, false)
        break
      case "leave": {
        const link = this.links.get(msg.peer.peer)
        if (link) {
          removeAwarenessStates(this.awareness, [...link.clients], "left")
          link.close()
          this.links.delete(msg.peer.peer)
          this.emitLinks()
        }
        break
      }
      case "signal":
        void this.links.get(msg.from)?.onSignal(msg.data)
        break
      case "reset":
        this.listeners.reset.forEach((fn) => fn())
        break
      case "error":
        console.warn("session:", msg.error)
        break
      case "ended":
        this.setStatus("ended")
        this.ws?.close()
        break
    }
  }

  private addLink(info: PeerInfo, initiator: boolean) {
    this.links.get(info.peer)?.close()
    this.links.set(info.peer, new Link(this, info, initiator))
    this.emitLinks()
  }

  /** Announces a reset of the project to everyone; the server accepts it from the owner only. */
  announceReset() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "reset" }))
  }

  sendSignal(to: number, data: SignalData) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "signal", to, data }))
  }

  sendRelay(to: number, frame: Uint8Array) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const out = new Uint8Array(frame.length + 4)
    new DataView(out.buffer).setUint32(0, to)
    out.set(frame, 4)
    this.ws.send(out)
  }

  // ---- peer messages ------------------------------------------------------

  /** A link is usable (direct or relay): exchange state with that member. */
  onLinkReady(link: Link) {
    for (const id of this.store.ids()) link.send(this.syncStep1(id, this.store.doc(id)))
    link.send(this.awarenessMessage([...this.awareness.getStates().keys()].filter((id) => id === this.clientID)))
  }

  /** Sends our changes to a document to everyone. */
  private watch(docId: string, doc: Y.Doc) {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin instanceof Link || !this.canWrite) return
      const enc = this.syncHeader(docId)
      syncProtocol.writeUpdate(enc, update)
      this.broadcast(encoding.toUint8Array(enc))
    }
    doc.on("update", onUpdate)
    this.detach.push(() => doc.off("update", onUpdate))
  }

  /** Sync messages carry the document they are about: [MSG_SYNC][docId][y-sync]. */
  private syncHeader(docId: string) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    encoding.writeVarString(enc, docId)
    return enc
  }

  private syncStep1(docId: string, doc: Y.Doc) {
    const enc = this.syncHeader(docId)
    syncProtocol.writeSyncStep1(enc, doc)
    return encoding.toUint8Array(enc)
  }

  onMessage(link: Link, message: Uint8Array) {
    const dec = decoding.createDecoder(message)
    const kind = decoding.readVarUint(dec)
    if (kind === MSG_SYNC) {
      const docId = decoding.readVarString(dec)
      // Unknown yet (its file's metadata has not arrived): we ask for it once it does.
      if (!this.store.has(docId)) return
      // Peek at the sync type: viewers may ask for state (step 1) but not change it.
      const syncType = decoding.peekVarUint(dec)
      if (link.info.role === "viewer" && syncType !== syncProtocol.messageYjsSyncStep1) return
      const enc = this.syncHeader(docId)
      const header = encoding.length(enc)
      syncProtocol.readSyncMessage(dec, enc, this.store.doc(docId), link)
      if (encoding.length(enc) > header) link.send(encoding.toUint8Array(enc))
    } else if (kind === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec)
      // Remember which awareness clients this link speaks for.
      const d2 = decoding.createDecoder(update)
      const n = decoding.readVarUint(d2)
      for (let i = 0; i < n; i++) {
        link.clients.add(decoding.readVarUint(d2))
        decoding.readVarUint(d2) // clock
        decoding.readVarString(d2) // state
      }
      applyAwarenessUpdate(this.awareness, update, link)
      this.emitLinks()
    } else if (kind === MSG_SIGNAL) {
      if (link.info.role === "viewer") return
      const signal = JSON.parse(decoding.readVarString(dec)) as Signal
      if (signal.to === this.clientID) this.listeners.signal.forEach((fn) => fn(signal))
    }
  }

  private awarenessMessage(clients: number[]) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, clients))
    return encoding.toUint8Array(enc)
  }

  private broadcast(message: Uint8Array) {
    this.links.forEach((link) => link.send(message))
  }

  emitLinks() {
    this.listeners.links.forEach((fn) => fn())
  }

  private setStatus(status: ProviderStatus) {
    this.status = status
    this.listeners.status.forEach((fn) => fn(status))
  }

  private onUnload = () => {
    removeAwarenessStates(this.awareness, [this.clientID], "unload")
  }
}

// ---- REST -------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export function createSession(mode: SessionMode) {
  return api<{ session: SessionInfo; role: Role }>("/api/sessions", { method: "POST", body: JSON.stringify({ mode }) })
}

export function getSession(code: string) {
  return api<{ session: SessionInfo & { endedAt?: string }; role: Role }>(`/api/sessions/${encodeURIComponent(code)}`)
}

export function endSession(code: string) {
  return api<void>(`/api/sessions/${encodeURIComponent(code)}/end`, { method: "POST" })
}

export function formatCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}
