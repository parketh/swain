import { render } from "ink"
import { App } from "./components/App"
import type { Controller } from "./controller"

export { App } from "./components/App"

export interface StartOptions {
  readonly controller: Controller
}

const ENTER_ALT_SCREEN = "\x1b[?1049h"
const LEAVE_ALT_SCREEN = "\x1b[?1049l"
// SGR mouse reporting (button events + extended coordinates). Enabling this
// also suppresses the terminal's alt-screen "alternate scroll" translation of
// the wheel into arrow keys, so wheel events reach us as distinct sequences
// (handled in App) instead of recalling prompt history.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h"
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l"

/**
 * Mounts the Ink app in the terminal's alternate screen buffer so the UI runs
 * full-screen with the prompt pinned to the bottom. The alt screen is left on
 * exit (and via a process-exit backstop, so a crash restores the main buffer).
 */
export const startApp = (options: StartOptions): void => {
  process.stdout.write(ENTER_ALT_SCREEN + ENABLE_MOUSE)
  let left = false
  const leave = (): void => {
    if (left) return
    left = true
    process.stdout.write(DISABLE_MOUSE + LEAVE_ALT_SCREEN)
  }
  process.once("exit", leave)
  const instance = render(<App controller={options.controller} />, { exitOnCtrlC: false })
  instance.waitUntilExit().then(leave, leave)
}
