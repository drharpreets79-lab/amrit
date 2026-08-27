/**
 * The MLLP listener: a TCP port on a machine that holds patient records.
 *
 * Phase 26. This is the highest-risk surface in the expansion plan, and the plan says why:
 * Phase 11 found three insecure defaults already shipped and needing correction. The rule
 * that came out of it is that this listener must be secure-by-default from its first commit,
 * so every setting below fails closed.
 *
 * ## What "secure by default" is made of here
 *
 * - **Off unless switched on.** `enabled` defaults to false. A deployment turns this on
 *   deliberately; nothing enables it as a side effect of an upgrade.
 * - **Refuses to start without a credential.** Not "warns", not "generates one" — `start()`
 *   throws. A listener with no credential is an open write path into a clinical database, and
 *   a generated-on-first-run secret is one nobody ever rotates because nobody ever saw it.
 * - **Loopback unless told otherwise, and never a wildcard.** Binding `0.0.0.0` requires
 *   naming the interface *and* listing the peers allowed to reach it. `0.0.0.0` with an empty
 *   allowlist is refused rather than accepted-with-a-warning.
 * - **Bounded everywhere.** Frame size, concurrent connections, messages per minute, and an
 *   idle timeout. Each has a stated reason below; none is decorative.
 *
 * ## The credential, and an honest statement of what it is worth
 *
 * The secret travels in `MSH-8`, which is v2's own Security field, and is compared in
 * constant time. **On a plaintext socket this authenticates the sender to a passive observer
 * exactly as well as any bearer token does: not at all.** MLLP has no transport security of
 * its own. What MSH-8 buys is that a process which merely reaches the port cannot write to
 * the database — which is the realistic threat on a hospital LAN — and it is why the default
 * bind is loopback, where "reaches the port" already means "is on this machine".
 *
 * A deployment exposing this beyond loopback should terminate TLS in front of it and treat
 * the credential as a second factor rather than the only one. That is a deployment decision
 * and `DEPLOYMENT.md` records it; this file's job is to make the insecure shape hard to
 * configure by accident, not to pretend the secure one is automatic.
 */

import { createServer, isIPv4, type Server, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'

import {
  DEFAULT_DELIMITERS, component, field, firstSegment, parseHl7Message, type Hl7Message
} from './hl7v2'

/** MLLP block framing, from the standard: <VT> message <FS><CR>. */
export const START_BLOCK = 0x0b
export const END_BLOCK = 0x1c
export const CARRIAGE_RETURN = 0x0d

export interface MllpListenerConfig {
  /** Off by default. Nothing turns this on as a side effect. */
  enabled: boolean
  host: string
  port: number
  /** Required. `start()` throws when empty — see the note on MSH-8 above. */
  credential: string
  /**
   * Peer addresses permitted when `host` is not a loopback address. Required in that case:
   * an externally bound listener with no allowlist is refused.
   */
  allowedPeers: string[]
  /** Bytes. A frame larger than this is dropped and the connection closed. */
  maxFrameBytes: number
  maxConnections: number
  maxMessagesPerMinute: number
  /** Milliseconds a connection may sit idle before it is closed. */
  idleTimeoutMs: number
}

export const DEFAULT_LISTENER_CONFIG: MllpListenerConfig = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 2575,
  credential: '',
  allowedPeers: [],
  // 1 MB. A microbiology ORU with a 40-drug panel is a few kilobytes; three orders of
  // magnitude of headroom is generous and still bounded.
  maxFrameBytes: 1024 * 1024,
  maxConnections: 8,
  maxMessagesPerMinute: 600,
  idleTimeoutMs: 60_000
})

export class InboundListenerError extends Error {}

/** What the listener decided about one message, and what it sent back. */
export interface InboundResult {
  /** `AA` accept, `AE` application error, `AR` reject. */
  acknowledgement: 'AA' | 'AE' | 'AR'
  /** Text placed in MSA-3 and, for a failure, in ERR. */
  text: string
  controlId: string
}

/** The application's handler. It is never given an unparsed or unauthenticated message. */
export type MessageHandler = (message: Hl7Message, peer: string) => Promise<InboundResult> | InboundResult

function isLoopback(host: string): boolean {
  const value = host.trim().toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
    || value.startsWith('127.')
}

/**
 * Constant-time credential comparison.
 *
 * `timingSafeEqual` throws on differing lengths, which would itself leak the length, so the
 * lengths are compared into the same boolean rather than short-circuiting the function.
 */
export function credentialMatches(supplied: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(String(supplied ?? ''), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // Compare a fixed-size digest-shaped pair so the comparison itself is length-independent.
  const width = Math.max(a.length, b.length, 1)
  const padded = (source: Buffer): Buffer => {
    const out = Buffer.alloc(width)
    source.copy(out)
    return out
  }
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length
}

/**
 * Reassembles MLLP frames from a stream.
 *
 * TCP gives no message boundaries, so a sender's one message can arrive as nine packets and
 * nine messages can arrive as one. This holds partial input between reads and yields only
 * complete frames.
 *
 * Bytes arriving **before** a start block are discarded rather than buffered. A sender that
 * never sends `<VT>` — a port scanner, an HTTP client that found the wrong port — would
 * otherwise grow this buffer without limit, which is a memory exhaustion bug reachable by
 * anyone who can open a socket.
 */
export class MllpFramer {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes: number) {}

  /** Feed bytes; get back whatever complete messages they completed. */
  push(chunk: Buffer): { messages: string[]; overflow: boolean } {
    const messages: string[] = []
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    for (;;) {
      const start = this.buffer.indexOf(START_BLOCK)
      if (start === -1) {
        // Nothing framed yet and no start byte in hand: keep nothing.
        this.buffer = Buffer.alloc(0)
        break
      }
      if (start > 0) this.buffer = this.buffer.subarray(start)

      const end = this.buffer.indexOf(END_BLOCK)
      if (end === -1) {
        if (this.buffer.length > this.maxFrameBytes) {
          this.buffer = Buffer.alloc(0)
          return { messages, overflow: true }
        }
        break
      }
      // A frame ends <FS><CR>; some senders omit the CR. Accept both rather than stalling.
      const after = this.buffer[end + 1]
      if (after === undefined && this.buffer.length === end + 1) break
      const consumed = after === CARRIAGE_RETURN ? end + 2 : end + 1
      const body = this.buffer.subarray(1, end)
      if (body.length > this.maxFrameBytes) {
        this.buffer = Buffer.alloc(0)
        return { messages, overflow: true }
      }
      messages.push(body.toString('utf8'))
      this.buffer = this.buffer.subarray(consumed)
    }
    return { messages, overflow: false }
  }
}

/** Wrap a message body in MLLP framing. */
export function frame(body: string): Buffer {
  return Buffer.concat([
    Buffer.from([START_BLOCK]),
    Buffer.from(body, 'utf8'),
    Buffer.from([END_BLOCK, CARRIAGE_RETURN])
  ])
}

function ackEscape(value: string): string {
  // An ACK is a message this node composes and a remote system parses. A delimiter reflected
  // out of the incoming control id would let a sender inject segments into our reply.
  return String(value ?? '')
    .replace(/\\/g, '\\E\\').replace(/\|/g, '\\F\\').replace(/\^/g, '\\S\\')
    .replace(/~/g, '\\R\\').replace(/&/g, '\\T\\').replace(/[\r\n]+/g, ' ')
}

/**
 * Build the acknowledgement for a message.
 *
 * Composed field by field rather than by echoing the inbound MSH, because echoing a header
 * this node did not write is how a hostile sender gets its own text into a reply that
 * downstream systems trust.
 */
export function buildAck(
  message: Hl7Message | null, result: InboundResult, receivingFacility = 'AMRIT'
): string {
  const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14)
  const delimiters = message?.delimiters ?? DEFAULT_DELIMITERS
  const header = message ? firstSegment(message, 'MSH') : null
  // The sender's application and facility become the ACK's receiver, which is what makes it
  // routable back.
  const receivingApplication = header ? component(header, 3, 1, delimiters) : ''
  const senderFacility = header ? component(header, 4, 1, delimiters) : ''
  const controlId = result.controlId || (header ? field(header, 10, delimiters) : '') || 'UNKNOWN'
  const segments = [
    `MSH|^~\\&|AMRIT|${ackEscape(receivingFacility)}|${ackEscape(receivingApplication)}`
      + `|${ackEscape(senderFacility)}|${stamp}||ACK^R01|${ackEscape(`${controlId}-ACK`)}|P|2.5.1`,
    `MSA|${result.acknowledgement}|${ackEscape(controlId)}|${ackEscape(result.text).slice(0, 200)}`
  ]
  if (result.acknowledgement !== 'AA') {
    // ERR-4 severity: E for an error the sender should act on. The reason travels in ERR-8 so
    // an operator at the sending system sees a sentence, not a code.
    segments.push(`ERR|||207^Application internal error^HL70357|E|||${ackEscape(result.text).slice(0, 500)}`)
  }
  return `${segments.join('\r')}\r`
}

interface ConnectionState {
  framer: MllpFramer
  timestamps: number[]
}

/**
 * The listener itself.
 *
 * Deliberately not started by construction: `start()` is where the refusals live, so
 * constructing one is safe and misconfiguration is loud.
 */
export class MllpListener {
  private server: Server | null = null
  private readonly connections = new Set<Socket>()
  private readonly state = new WeakMap<Socket, ConnectionState>()

  constructor(
    private readonly config: MllpListenerConfig,
    private readonly handler: MessageHandler,
    private readonly log: (event: string, detail: Record<string, unknown>) => void = () => {}
  ) {}

  /** Every reason this configuration would be refused, as sentences. Empty means startable. */
  static refusals(config: MllpListenerConfig): string[] {
    const problems: string[] = []
    if (!config.credential || config.credential.trim().length === 0) {
      problems.push(
        'The inbound listener has no credential. It will not start without one: an unauthenticated '
        + 'listener is a write path into the patient database for anything that can reach the port. '
        + 'Set a shared secret here and in the sending system, which puts it in MSH-8.'
      )
    } else if (config.credential.trim().length < 16) {
      problems.push(
        `The inbound credential is ${config.credential.trim().length} characters. At least 16 are `
        + 'required: this value is the only thing standing between the network and a clinical write.'
      )
    }
    const host = config.host.trim()
    if (!host) {
      problems.push('The inbound listener has no bind address.')
    } else if (host === '0.0.0.0' || host === '::' || host === '*') {
      problems.push(
        `Refusing to bind ${host}: a wildcard bind exposes the listener on every interface the `
        + 'machine has, including ones the operator did not think about. Name the interface to '
        + 'bind, and list the peers allowed to reach it.'
      )
    } else if (!isLoopback(host) && config.allowedPeers.length === 0) {
      problems.push(
        `Refusing to bind ${host} with an empty peer allowlist. A listener reachable from the `
        + 'network must state which senders may use it; "any host that can route here" is not a '
        + 'decision anyone made on purpose.'
      )
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
      problems.push(`${config.port} is not a usable TCP port.`)
    }
    if (config.maxFrameBytes < 1024 || config.maxFrameBytes > 16 * 1024 * 1024) {
      problems.push('The frame cap must be between 1 KB and 16 MB.')
    }
    return problems
  }

  /**
   * Bind and accept. Throws `InboundListenerError` rather than starting insecurely.
   *
   * A disabled listener is not an error — it is the default — so `start()` on one resolves
   * having done nothing, and `listening` stays false.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.log('inbound.disabled', { reason: 'The inbound listener is off. This is the default.' })
      return
    }
    const refusals = MllpListener.refusals(this.config)
    if (refusals.length > 0) throw new InboundListenerError(refusals.join(' '))

    const server = createServer((socket) => this.accept(socket))
    server.maxConnections = this.config.maxConnections
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, this.config.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.log('inbound.started', {
      host: this.config.host, port: this.config.port,
      loopbackOnly: isLoopback(this.config.host), peers: this.config.allowedPeers.length
    })
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) socket.destroy()
    this.connections.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.log('inbound.stopped', {})
  }

  private peerOf(socket: Socket): string {
    const address = socket.remoteAddress ?? ''
    // Node reports an IPv4 peer on a dual-stack socket as ::ffff:127.0.0.1.
    return address.startsWith('::ffff:') && isIPv4(address.slice(7)) ? address.slice(7) : address
  }

  private accept(socket: Socket): void {
    const peer = this.peerOf(socket)
    if (this.config.allowedPeers.length > 0 && !this.config.allowedPeers.includes(peer)) {
      // Closed without a reply. Telling an unlisted peer *why* it was refused tells a scanner
      // that something worth talking to is here.
      this.log('inbound.peer-refused', { peer })
      socket.destroy()
      return
    }
    this.connections.add(socket)
    this.state.set(socket, { framer: new MllpFramer(this.config.maxFrameBytes), timestamps: [] })
    socket.setTimeout(this.config.idleTimeoutMs)
    socket.on('timeout', () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.connections.delete(socket))
    socket.on('data', (chunk: Buffer) => {
      void this.consume(socket, chunk, peer)
    })
  }

  private rateLimited(state: ConnectionState): boolean {
    const now = Date.now()
    state.timestamps = state.timestamps.filter((at) => now - at < 60_000)
    if (state.timestamps.length >= this.config.maxMessagesPerMinute) return true
    state.timestamps.push(now)
    return false
  }

  private async consume(socket: Socket, chunk: Buffer, peer: string): Promise<void> {
    const state = this.state.get(socket)
    if (!state) return
    const { messages, overflow } = state.framer.push(chunk)
    if (overflow) {
      this.log('inbound.frame-too-large', { peer, limit: this.config.maxFrameBytes })
      socket.destroy()
      return
    }
    for (const body of messages) {
      if (this.rateLimited(state)) {
        this.log('inbound.rate-limited', { peer })
        socket.destroy()
        return
      }
      const reply = await this.dispatch(body, peer)
      if (!socket.destroyed) socket.write(frame(reply))
    }
  }

  /**
   * Parse, authenticate, hand to the application, and turn anything that goes wrong into an
   * acknowledgement.
   *
   * The `catch` is the load-bearing part. A handler that throws — a database that is locked, a
   * bug in reconciliation, an assertion nobody expected — must produce a NACK and leave the
   * listener accepting. An inbound listener that dies on one bad message is a denial of
   * service against every laboratory using it, triggered by whichever sender got unlucky.
   */
  private async dispatch(body: string, peer: string): Promise<string> {
    let message: Hl7Message | null = null
    try {
      message = parseHl7Message(body)
      if (!message.usable) {
        const reason = message.issues.filter((issue) => issue.severity === 'error')
          .map((issue) => `${issue.location}: ${issue.message}`).join(' ')
        this.log('inbound.rejected', { peer, reason: reason.slice(0, 200) })
        return buildAck(message, { acknowledgement: 'AR', text: reason, controlId: message.controlId })
      }

      const header = firstSegment(message, 'MSH')
      const supplied = field(header, 8, message.delimiters)
      if (!credentialMatches(supplied, this.config.credential)) {
        // Same text whether MSH-8 was absent, wrong, or malformed: distinguishing them tells
        // an attacker which half of the guess to keep.
        this.log('inbound.unauthenticated', { peer, controlId: message.controlId })
        return buildAck(message, {
          acknowledgement: 'AR',
          text: 'Not authenticated. MSH-8 must carry the credential agreed with this node.',
          controlId: message.controlId
        })
      }

      const result = await this.handler(message, peer)
      this.log('inbound.handled', {
        peer, controlId: message.controlId, acknowledgement: result.acknowledgement
      })
      return buildAck(message, result)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log('inbound.handler-failed', { peer, detail: detail.slice(0, 200) })
      return buildAck(message, {
        acknowledgement: 'AE',
        // The sender is told the message was not filed, and nothing about why internally: an
        // exception message can carry a file path or a SQL fragment.
        text: 'The message was received but could not be filed. It was not stored. Contact the '
          + 'receiving site; the failure is recorded in its audit log.',
        controlId: message?.controlId ?? ''
      })
    }
  }
}
