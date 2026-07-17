// Build-time version. Source/development runs report `dev`; release builds
// replace `__SWAIN_VERSION__` via Bun `--define` with the tag semantic-release
// computes for the run (passed through the build script's `--version`).
declare const __SWAIN_VERSION__: string

export const version = (): string =>
  typeof __SWAIN_VERSION__ === "string" && __SWAIN_VERSION__ !== "" ? __SWAIN_VERSION__ : "dev"
