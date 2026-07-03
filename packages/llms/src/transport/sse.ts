export interface SSEEvent {
  readonly event?: string
  readonly data: string
}

const DONE = "[DONE]"

const isDone = (event: SSEEvent): boolean => event.data.trim() === DONE

interface Decoder {
  /** Feeds a text chunk and returns events completed by it. */
  feed(chunk: string): Array<SSEEvent>
  /** Flushes remaining buffered lines; per the SSE spec an unterminated event is discarded. */
  end(): Array<SSEEvent>
}

/**
 * Incremental server-sent-events decoder. Handles `data:` lines (multi-line
 * payloads joined with newlines), optional `event:` names, blank-line event
 * boundaries, and ignores comments and unknown fields.
 */
const makeDecoder = (): Decoder => {
  let buffer = ""
  let eventName: string | undefined
  let dataLines: Array<string> = []

  const dispatch = (): SSEEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const event: SSEEvent = {
      ...(eventName === undefined ? {} : { event: eventName }),
      data: dataLines.join("\n"),
    }
    eventName = undefined
    dataLines = []
    return event
  }

  const consumeLine = (line: string): SSEEvent | undefined => {
    if (line === "") {
      return dispatch()
    }
    if (line.startsWith(":")) {
      return undefined
    }
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) {
      value = value.slice(1)
    }
    switch (field) {
      case "data":
        dataLines.push(value)
        return undefined
      case "event":
        eventName = value
        return undefined
      default:
        return undefined
    }
  }

  return {
    feed(chunk) {
      buffer += chunk
      const events: Array<SSEEvent> = []
      for (;;) {
        const match = buffer.match(/\r\n|\r|\n/)
        if (match === null || match.index === undefined) {
          break
        }
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const event = consumeLine(line)
        if (event !== undefined) {
          events.push(event)
        }
      }
      return events
    },
    end() {
      buffer = ""
      eventName = undefined
      dataLines = []
      return []
    },
  }
}

/** Decodes a complete SSE document. A trailing event is dispatched even without a final blank line. */
const decode = (text: string): Array<SSEEvent> => {
  const decoder = makeDecoder()
  const events = decoder.feed(text.endsWith("\n") ? `${text}\n` : `${text}\n\n`)
  decoder.end()
  return events
}

export const SSE = {
  decode,
  makeDecoder,
  isDone,
}
