import { statSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Resolves the packaged ripgrep sidecar from an executable path. A compiled
 * Swain lives at `bin/swain` with its private `rg` at `libexec/rg`, so the
 * sidecar is `../libexec/rg` relative to the executable. Returns the path only
 * when it exists as a file; source/development runs (where no sidecar is
 * staged) get `undefined` and fall back to the system `rg`.
 */
export const resolveSidecarRg = (execPath: string): string | undefined => {
  const candidate = resolve(dirname(execPath), "..", "libexec", "rg")
  try {
    return statSync(candidate).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Points `SWAIN_RG_PATH` at the packaged sidecar when one is present and the
 * caller has not already set it. An explicit `SWAIN_RG_PATH` always wins and is
 * never overwritten — the sidecar stays private and is never added to `PATH`.
 */
export const configureSidecarRg = (
  env: Record<string, string | undefined>,
  execPath: string,
): void => {
  if (env.SWAIN_RG_PATH) return
  const rg = resolveSidecarRg(execPath)
  if (rg) env.SWAIN_RG_PATH = rg
}
