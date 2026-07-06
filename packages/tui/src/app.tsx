import { render } from "ink"
import { App } from "./components/App"
import type { Controller } from "./controller"

export { App } from "./components/App"

export interface StartOptions {
  readonly controller: Controller
}

const ENTER_ALT_SCREEN = "\x1b[?1049h"
const LEAVE_ALT_SCREEN = "\x1b[?1049l"

/**
 * Mounts the Ink app in the terminal's alternate screen buffer so the UI runs
 * full-screen with the prompt pinned to the bottom. The alt screen is left on
 * exit (and via a process-exit backstop, so a crash restores the main buffer).
 */
export const startApp = (options: StartOptions): void => {
  process.stdout.write(ENTER_ALT_SCREEN)
  let left = false
  const leave = (): void => {
    if (left) return
    left = true
    process.stdout.write(LEAVE_ALT_SCREEN)
  }
  process.once("exit", leave)
  const instance = render(<App controller={options.controller} />, { exitOnCtrlC: false })
  instance.waitUntilExit().then(leave, leave)
}
