#!/usr/bin/env bun
/**
 * Raw stdin key logger. Run it, press the keys you care about, and it prints the
 * exact bytes your terminal sends so we can bind them precisely.
 *
 *   bun packages/tui/scripts/keylog.ts
 *
 * Press: Option+Left, Option+Right, Shift+Enter, plain Enter. Then Ctrl+C.
 */

const stdin = process.stdin
stdin.setRawMode?.(true)
stdin.resume()
stdin.setEncoding("utf8")

console.log("keylog: press keys (Option+Left/Right, Shift+Enter, Enter). Ctrl+C to exit.\n")

const describe = (s: string): string =>
  [...s]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      if (code === 0x1b) return "ESC"
      if (code === 0x0d) return "CR(\\r)"
      if (code === 0x0a) return "LF(\\n)"
      if (code === 0x09) return "TAB"
      if (code < 0x20) return `^${String.fromCharCode(code + 64)}`
      return ch
    })
    .join(" ")

stdin.on("data", (data: string) => {
  if (data === "") {
    // Ctrl+C
    process.stdout.write("\nbye\n")
    process.exit(0)
  }
  const bytes = [...data].map((c) => `0x${(c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`)
  process.stdout.write(
    `raw=${JSON.stringify(data)}  tokens=[${describe(data)}]  bytes=[${bytes.join(" ")}]\n`,
  )
})
