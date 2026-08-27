/**
 * An HL7 v2.5.1 parser for messages this node did not write.
 *
 * Phase 26. Everything else in this codebase that reads structured data reads a file an
 * operator chose. This reads bytes off a socket, from a laboratory information system nobody
 * here controls, on a machine holding patient records. That difference is the whole design:
 *
 * 1. **It never throws.** A parser that throws on malformed input hands the caller a choice
 *    between crashing the listener and swallowing the error. Every failure is a value —
 *    `issues` on the returned message — so the listener can NACK with a reason and stay up.
 * 2. **Every loop is bounded.** The limits below are not tuning parameters, they are the
 *    reason a 40-byte message cannot allocate a gigabyte. v2 has no length field, so nothing
 *    in the format itself stops a sender claiming 10,000,000 repetitions of one field.
 * 3. **It is tolerant where the standard is permissive and strict where it is not.** Real v2
 *    reorders segments, invents Z-segments, omits optional fields and codes in local
 *    vocabularies. None of that is an error. A missing MSH, an unparseable version, or a
 *    message type this node does not accept *is*.
 *
 * ## What tolerant means, concretely
 *
 * `segments` preserves arrival order and keeps everything, Z-segments included, because a
 * segment this parser does not understand is still evidence for a human reading a quarantined
 * message. Lookups go through `segmentsOf`, which finds segments by id wherever they landed,
 * so a sender that puts SPM after OBR — or before PID — is read correctly rather than
 * silently losing its specimen.
 *
 * ## What this file deliberately does not do
 *
 * It does not interpret. `MSH-9` is returned as text, not as a decision to accept the
 * message; an OBX value is returned as text, not as a susceptibility result. Reconciliation
 * and clinical meaning live in `reconcile.ts` and `ingest.ts`, where the terminology seed and
 * the database are available. Keeping this file free of both is what makes it fuzzable.
 */

/** Limits. A hostile sender chooses the input; this file chooses what it will spend on it. */
export const HL7_LIMITS = Object.freeze({
  /** Bytes. The MLLP listener caps the frame too; this guards non-socket callers. */
  maxMessageBytes: 1024 * 1024,
  maxSegments: 10_000,
  maxFieldsPerSegment: 512,
  maxRepetitions: 256,
  maxComponents: 128,
  /** Characters produced by one `\X..\` escape. Prevents an expansion bomb. */
  maxHexEscapeBytes: 64
})

export interface Hl7Issue {
  severity: 'error' | 'warning'
  /** Segment id and ordinal where known, e.g. `OBX[3]`, or `message`. */
  location: string
  message: string
}

export interface Hl7Delimiters {
  field: string
  component: string
  repetition: string
  escape: string
  subcomponent: string
}

/** v2's defaults, and what `MSH-2` almost always says. */
export const DEFAULT_DELIMITERS: Hl7Delimiters = Object.freeze({
  field: '|',
  component: '^',
  repetition: '~',
  escape: '\\',
  subcomponent: '&'
})

export interface Hl7Segment {
  id: string
  /**
   * Raw field text, **1-indexed to match the standard**, so `fields[3]` is PID-3 and reading
   * this file next to the specification does not require arithmetic. `fields[0]` is the
   * segment id. MSH is special-cased so `fields[1]` is the field separator and `fields[2]`
   * the encoding characters, exactly as MSH-1 and MSH-2 are defined.
   */
  fields: string[]
  /** 0-based position in the message as it arrived, before any reordering. */
  index: number
}

export interface Hl7Message {
  segments: Hl7Segment[]
  delimiters: Hl7Delimiters
  issues: Hl7Issue[]
  /** MSH-9 as `ORU^R01`, empty when absent. */
  messageType: string
  /** MSH-10. The sender's own id, echoed in the ACK so it can correlate. */
  controlId: string
  /** MSH-12, e.g. `2.5.1`. */
  version: string
  sendingApplication: string
  sendingFacility: string
  /** MSH-11: `P` production, `D` debugging, `T` training. */
  processingId: string
  /** False when `issues` holds anything of severity `error`. */
  usable: boolean
}

const isError = (issue: Hl7Issue): boolean => issue.severity === 'error'

/**
 * Undo v2's escape sequences.
 *
 * The sequences are the standard's own: `\F\` `\S\` `\T\` `\R\` `\E\` restore the five
 * delimiters, `\Xdd..\` is hexadecimal, and the formatting commands (`\H\`, `\N\`, `\.br\`)
 * are display instructions with no place in stored data and are dropped.
 *
 * An **unrecognised** escape is returned verbatim rather than dropped or guessed at. That is
 * the conservative choice: a sender's private escape is data this node does not understand,
 * and silently deleting a run of characters from a patient identifier is worse than carrying
 * a string that looks odd to a human who can then ask.
 */
export function decodeEscapes(value: string, delimiters: Hl7Delimiters): string {
  const escape = delimiters.escape
  if (!value || !escape || !value.includes(escape)) return value
  let output = ''
  let position = 0
  while (position < value.length) {
    const start = value.indexOf(escape, position)
    if (start === -1) {
      output += value.slice(position)
      break
    }
    output += value.slice(position, start)
    const end = value.indexOf(escape, start + 1)
    if (end === -1) {
      // An unterminated escape. Keep the rest as literal text; the alternative is to discard
      // everything after a stray backslash.
      output += value.slice(start)
      break
    }
    const code = value.slice(start + 1, end)
    switch (code.charAt(0).toUpperCase()) {
      case 'F': output += code.length === 1 ? delimiters.field : `${escape}${code}${escape}`; break
      case 'S': output += code.length === 1 ? delimiters.component : `${escape}${code}${escape}`; break
      case 'T': output += code.length === 1 ? delimiters.subcomponent : `${escape}${code}${escape}`; break
      case 'R': output += code.length === 1 ? delimiters.repetition : `${escape}${code}${escape}`; break
      case 'E': output += code.length === 1 ? escape : `${escape}${code}${escape}`; break
      case 'X': {
        const hex = code.slice(1)
        // Bounded, and only if it is actually hexadecimal. `\XZZ\` is not a number and is
        // kept as text rather than turned into replacement characters.
        if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2 !== 0
          || hex.length / 2 > HL7_LIMITS.maxHexEscapeBytes) {
          output += `${escape}${code}${escape}`
          break
        }
        let decoded = ''
        for (let offset = 0; offset < hex.length; offset += 2) {
          decoded += String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 2), 16))
        }
        output += decoded
        break
      }
      case 'H': case 'N': break // Display highlighting. Not data.
      case '.': break           // \.br\, \.sp\ and friends: formatting commands.
      case 'C': case 'M': break // Single- and multi-byte character-set switches.
      case 'Z': output += `${escape}${code}${escape}`; break // Locally defined: kept verbatim.
      default: output += `${escape}${code}${escape}`
    }
    position = end + 1
  }
  return output
}

/**
 * The delimiters this message declares, from `MSH-1` and `MSH-2`.
 *
 * A sender may legally choose its own. Reading them from the message rather than assuming
 * `|^~\&` is what lets a system that uses `#` as its field separator be parsed at all — and
 * assuming the defaults against such a sender would not fail loudly, it would parse the whole
 * message as one enormous field.
 */
function readDelimiters(header: string): { delimiters: Hl7Delimiters; issues: Hl7Issue[] } {
  const issues: Hl7Issue[] = []
  const field = header.charAt(3)
  if (!field) {
    return { delimiters: DEFAULT_DELIMITERS, issues }
  }
  const encoding = header.slice(4, header.indexOf(field, 4) === -1 ? 8 : header.indexOf(field, 4))
  const delimiters: Hl7Delimiters = {
    field,
    component: encoding.charAt(0) || DEFAULT_DELIMITERS.component,
    repetition: encoding.charAt(1) || DEFAULT_DELIMITERS.repetition,
    escape: encoding.charAt(2) || DEFAULT_DELIMITERS.escape,
    subcomponent: encoding.charAt(3) || DEFAULT_DELIMITERS.subcomponent
  }
  const distinct = new Set(Object.values(delimiters))
  if (distinct.size !== 5) {
    issues.push({
      severity: 'error',
      location: 'MSH-2',
      message: `The message declares delimiters that are not distinct (${JSON.stringify(delimiters)}). `
        + 'Parsing cannot proceed: a component separator that is also the field separator makes '
        + 'every field boundary ambiguous, and guessing which was meant would silently move data '
        + 'between fields.'
    })
  }
  return { delimiters, issues }
}

/**
 * Parse a message. Always returns; never throws.
 *
 * @param raw the message body, MLLP framing already removed.
 */
export function parseHl7Message(raw: string): Hl7Message {
  const issues: Hl7Issue[] = []
  const empty = (): Hl7Message => ({
    segments: [], delimiters: DEFAULT_DELIMITERS, issues, messageType: '', controlId: '',
    version: '', sendingApplication: '', sendingFacility: '', processingId: '', usable: false
  })

  if (typeof raw !== 'string' || raw.length === 0) {
    issues.push({ severity: 'error', location: 'message', message: 'The message is empty.' })
    return empty()
  }
  if (raw.length > HL7_LIMITS.maxMessageBytes) {
    issues.push({
      severity: 'error',
      location: 'message',
      message: `The message is ${raw.length} characters; the limit is ${HL7_LIMITS.maxMessageBytes}. `
        + 'Refused unparsed — the point of a cap is not to allocate for it.'
    })
    return empty()
  }

  // v2 terminates segments with a carriage return. Real senders use LF or CRLF anyway, and a
  // message rejected over a line ending is a message a laboratory cannot send.
  const lines = raw.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    issues.push({ severity: 'error', location: 'message', message: 'The message has no segments.' })
    return empty()
  }
  if (lines.length > HL7_LIMITS.maxSegments) {
    issues.push({
      severity: 'error',
      location: 'message',
      message: `The message has ${lines.length} segments; the limit is ${HL7_LIMITS.maxSegments}.`
    })
    return empty()
  }

  const headerLine = lines[0] ?? ''
  if (!headerLine.startsWith('MSH')) {
    issues.push({
      severity: 'error',
      location: 'message',
      message: `The first segment is "${headerLine.slice(0, 3)}", not MSH. Without a header there `
        + 'is no declared encoding, no message type and no control id to acknowledge against, so '
        + 'the message is refused rather than parsed with assumed delimiters.'
    })
    return empty()
  }

  const { delimiters, issues: delimiterIssues } = readDelimiters(headerLine)
  issues.push(...delimiterIssues)
  if (delimiterIssues.some(isError)) {
    return { ...empty(), delimiters }
  }

  const segments: Hl7Segment[] = []
  lines.forEach((line, index) => {
    const parts = line.split(delimiters.field)
    const id = (parts[0] ?? '').trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9]{2}$/.test(id)) {
      issues.push({
        severity: 'warning',
        location: `segment[${index}]`,
        message: `"${(parts[0] ?? '').slice(0, 12)}" is not a segment identifier. The segment is `
          + 'kept unparsed so a human reviewing a quarantined message can still see it.'
      })
      return
    }
    // MSH-1 *is* the field separator, so the split that found it consumed it. Re-inserting it
    // as fields[1] makes MSH-3 read as fields[3], like every other segment.
    const fields = id === 'MSH'
      ? [id, delimiters.field, ...parts.slice(1)]
      : [...parts]
    if (fields.length > HL7_LIMITS.maxFieldsPerSegment) {
      issues.push({
        severity: 'warning',
        location: `${id}[${index}]`,
        message: `${fields.length} fields; truncated at ${HL7_LIMITS.maxFieldsPerSegment}.`
      })
      fields.length = HL7_LIMITS.maxFieldsPerSegment
    }
    segments.push({ id, fields, index })
  })

  const header = segments.find((segment) => segment.id === 'MSH')
  if (!header) {
    issues.push({ severity: 'error', location: 'message', message: 'No MSH segment survived parsing.' })
    return { ...empty(), delimiters, segments }
  }

  const messageType = field(header, 9, delimiters)
  const version = component(header, 12, 1, delimiters)
  if (!version) {
    issues.push({
      severity: 'warning',
      location: 'MSH-12',
      message: 'The message declares no version. It is parsed as 2.5.1, which is what this node '
        + 'implements, and the assumption is recorded rather than hidden.'
    })
  } else if (!version.startsWith('2.')) {
    issues.push({
      severity: 'error',
      location: 'MSH-12',
      message: `This node implements HL7 v2.x and the message declares "${version}". Refused: `
        + 'parsing a v3 or FHIR payload with a v2 parser produces plausible nonsense.'
    })
  }

  const message: Hl7Message = {
    segments,
    delimiters,
    issues,
    messageType,
    controlId: field(header, 10, delimiters),
    version: version || '2.5.1',
    sendingApplication: component(header, 3, 1, delimiters),
    sendingFacility: component(header, 4, 1, delimiters),
    processingId: component(header, 11, 1, delimiters),
    usable: false
  }
  message.usable = !issues.some(isError)
  return message
}

/** Every segment with this id, in arrival order. Tolerates any segment ordering. */
export function segmentsOf(message: Hl7Message, id: string): Hl7Segment[] {
  const wanted = id.trim().toUpperCase()
  return message.segments.filter((segment) => segment.id === wanted)
}

export function firstSegment(message: Hl7Message, id: string): Hl7Segment | null {
  return segmentsOf(message, id)[0] ?? null
}

/** One field, escapes decoded, repetitions joined back with the repetition separator. */
export function field(segment: Hl7Segment | null, position: number, delimiters: Hl7Delimiters): string {
  if (!segment) return ''
  return decodeEscapes((segment.fields[position] ?? '').trim(), delimiters)
}

/** The repetitions of one field, bounded. */
export function repetitions(
  segment: Hl7Segment | null, position: number, delimiters: Hl7Delimiters
): string[] {
  if (!segment) return []
  const raw = segment.fields[position] ?? ''
  if (!raw) return []
  return raw.split(delimiters.repetition).slice(0, HL7_LIMITS.maxRepetitions)
}

/**
 * One component of one repetition, 1-indexed like the standard.
 *
 * `component(pid, 5, 1)` is the family name in `PID-5`, whether the sender wrote
 * `Smith^John` or the bare `Smith` — a field with no component separator is its own first
 * component, which is what makes this safe against the very common single-component sender.
 */
export function component(
  segment: Hl7Segment | null, position: number, index: number, delimiters: Hl7Delimiters,
  repetition = 0
): string {
  if (!segment) return ''
  const parts = repetitions(segment, position, delimiters)
  const chosen = parts[repetition] ?? ''
  const components = chosen.split(delimiters.component).slice(0, HL7_LIMITS.maxComponents)
  return decodeEscapes((components[index - 1] ?? '').trim(), delimiters)
}

/** One subcomponent, for the rare sender that uses them. */
export function subcomponent(
  segment: Hl7Segment | null, position: number, index: number, sub: number,
  delimiters: Hl7Delimiters, repetition = 0
): string {
  if (!segment) return ''
  const parts = repetitions(segment, position, delimiters)
  const components = (parts[repetition] ?? '').split(delimiters.component)
  const subs = (components[index - 1] ?? '').split(delimiters.subcomponent)
  return decodeEscapes((subs[sub - 1] ?? '').trim(), delimiters)
}

/**
 * A CWE/CE coded element: identifier, text and coding system, with the alternate triplet.
 *
 * This is the shape a local code arrives in, and the reason reconciliation is possible at
 * all. A sender that puts its own code in components 1–3 and a standard one in 4–6 is telling
 * this node exactly what it needs, and the outbound exporter in `services.ts` writes the same
 * shape — so AMRIT can read its own output, which is the cheapest interoperability test there
 * is.
 */
export interface CodedElement {
  code: string
  text: string
  system: string
  alternateCode: string
  alternateText: string
  alternateSystem: string
}

export function codedElement(
  segment: Hl7Segment | null, position: number, delimiters: Hl7Delimiters, repetition = 0
): CodedElement {
  return {
    code: component(segment, position, 1, delimiters, repetition),
    text: component(segment, position, 2, delimiters, repetition),
    system: component(segment, position, 3, delimiters, repetition),
    alternateCode: component(segment, position, 4, delimiters, repetition),
    alternateText: component(segment, position, 5, delimiters, repetition),
    alternateSystem: component(segment, position, 6, delimiters, repetition)
  }
}

/**
 * A v2 timestamp (`YYYYMMDDHHMMSS[.S+][+/-ZZZZ]`) as the `YYYY-MM-DD` this codebase stores.
 *
 * Partial precision is real and common: `2026` and `202608` are legal DTM values. A partial
 * date becomes an empty string rather than being padded to the first of the month, because a
 * specimen date is used to bin cases into epidemiological weeks and a fabricated day would
 * move a case into a week it did not occur in.
 */
export function hl7DateToIso(value: string): string {
  const digits = String(value ?? '').replace(/[^0-9]/g, '')
  if (digits.length < 8) return ''
  const year = digits.slice(0, 4)
  const month = digits.slice(4, 6)
  const day = digits.slice(6, 8)
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return ''
  // Reject a date the calendar does not have — 31 February parses arithmetically and is not
  // a day anything happened on.
  const candidate = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(candidate.getTime()) || candidate.getUTCDate() !== dayNumber) return ''
  return `${year}-${month}-${day}`
}
