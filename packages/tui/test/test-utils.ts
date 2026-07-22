// Polls until `predicate` holds instead of racing a fixed sleep — an async
// state transition can take longer than one `flush()` on a slow CI runner.
// On timeout it dumps `describe()` (the last frame) so a CI-only hang reveals
// what was actually on screen.
export const waitFor = async (
  predicate: () => boolean,
  opts: { timeoutMs?: number; describe?: () => string } = {},
): Promise<void> => {
  const { timeoutMs = 4000, describe } = opts
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `waitFor: condition not met in ${timeoutMs}ms${describe ? `\n--- last frame ---\n${describe()}` : ""}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// Re-sends a key until `predicate` holds. A keypress fired immediately after an
// async UI transition can reach a not-yet-active input handler on a slow CI
// runner and be dropped; retrying until the expected frame appears is race-free
// (a real user presses long after the target mounts).
export const pressUntil = async (
  press: () => void,
  predicate: () => boolean,
  describe: () => string,
  { timeoutMs = 4000, intervalMs = 150 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `pressUntil: condition not met in ${timeoutMs}ms\n--- last frame ---\n${describe()}`,
      )
    }
    press()
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
