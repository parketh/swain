import { render } from "ink"
import { App } from "./components/App"
import type { Controller } from "./controller"

export { App } from "./components/App"

export interface StartOptions {
  readonly controller: Controller
}

/** Mounts the Ink app. Ctrl+C interrupts a running turn or exits when idle. */
export const startApp = (options: StartOptions): void => {
  render(<App controller={options.controller} />, { exitOnCtrlC: false })
}
