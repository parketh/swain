import { useStdout } from "ink"
import { useEffect, useState } from "react"

export interface TerminalSize {
  readonly rows: number
  readonly columns: number
}

/** Tracks the terminal's row/column dimensions, updating on SIGWINCH resize. */
export const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout()
  const [size, setSize] = useState<TerminalSize>({
    rows: stdout.rows ?? 24,
    columns: stdout.columns ?? 80,
  })
  useEffect(() => {
    const onResize = (): void => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 })
    stdout.on("resize", onResize)
    return () => {
      stdout.off("resize", onResize)
    }
  }, [stdout])
  return size
}
