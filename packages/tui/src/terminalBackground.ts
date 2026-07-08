/**
 * Terminal background-color detection via the OSC 11 query (`ESC ] 11 ; ? ST`).
 * VS Code, Cursor, Ghostty, iTerm2, kitty, Alacritty, WezTerm and Terminal.app
 * all reply with `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` (BEL- or ST-terminated).
 * Terminals that don't support the query simply never answer, so the query
 * resolves `undefined` after a short timeout and the theme keeps its defaults.
 */

const hexByte = (value: number): string => value.toString(16).padStart(2, "0")

/** Scale one 1–4 hex-digit OSC color component to 8-bit. */
const scaleComponent = (component: string): number =>
  Math.round((Number.parseInt(component, 16) * 255) / (16 ** component.length - 1))

/** Extract `#rrggbb` from an OSC 11 reply, or undefined if none is present. */
export const parseOsc11 = (data: string): string | undefined => {
  const match = data.match(/\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/)
  if (match === null) return undefined
  const [, r, g, b] = match
  return `#${hexByte(scaleComponent(r!))}${hexByte(scaleComponent(g!))}${hexByte(scaleComponent(b!))}`
}

const channels = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

export const isDark = (hex: string): boolean => {
  const [r, g, b] = channels(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/** Mix `hex` toward white (amount > 0) or black (amount < 0). */
export const mix = (hex: string, amount: number): string => {
  const target = amount > 0 ? 255 : 0
  const t = Math.abs(amount)
  const [r, g, b] = channels(hex)
  const blend = (c: number): string => hexByte(Math.round(c + (target - c) * t))
  return `#${blend(r)}${blend(g)}${blend(b)}`
}

/** A subtle shade of the background for highlighted bands (user prompts). */
export const shadeFor = (bg: string): string => (isDark(bg) ? mix(bg, 0.1) : mix(bg, -0.08))

/**
 * Ask the terminal for its background color. Must run before Ink attaches to
 * stdin: it briefly puts stdin in raw mode to read the reply, then restores it.
 *
 * Reads via `readable` + `read()` (paused mode) exactly like Ink does — never
 * `resume()`/`pause()`. Flowing the stream and then pausing it leaves Bun's
 * stdin in a state where Ink's later `ref()` + `readable` listener holds no
 * event-loop reference, so the process exits right after the first render.
 */
export const queryTerminalBackground = async (timeoutMs = 150): Promise<string | undefined> => {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) return undefined
  return new Promise((resolve) => {
    let data = ""
    const wasRaw = stdin.isRaw === true
    const finish = (result: string | undefined): void => {
      clearTimeout(timer)
      stdin.off("readable", onReadable)
      stdin.setRawMode(wasRaw)
      resolve(result)
    }
    const onReadable = (): void => {
      let chunk = stdin.read()
      while (chunk !== null) {
        data += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("latin1")
        chunk = stdin.read()
      }
      const color = parseOsc11(data)
      if (color !== undefined) finish(color)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    stdin.setRawMode(true)
    stdin.on("readable", onReadable)
    stdout.write("\x1b]11;?\x1b\\")
  })
}
