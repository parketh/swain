#!/usr/bin/env bun
/**
 * Release artifact builder. Cross-compiles Swain for the Linux x64 targets,
 * packages each executable with its private ripgrep sidecar, licenses, and a
 * machine-readable manifest, then writes normalized `.tar.gz` archives and a
 * sorted `checksums.txt` index.
 *
 *   bun run build:release -- --version X.Y.Z --commit <sha> [--target <name>|--all]
 *
 * The pure pieces (target table, validators, manifest, checksum index, archive
 * assembly) are exported for unit testing; the build pipeline runs only when the
 * script is the process entrypoint.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"

// --- Pinned inputs -----------------------------------------------------------

export const BUN_VERSION = "1.3.14"
export const RIPGREP_VERSION = "15.1.0"
export const RIPGREP_ASSET = `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`
export const RIPGREP_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${RIPGREP_ASSET}`
// The static-PIE musl `rg` runs under any container libc; pin its upstream digest.
export const RIPGREP_SOURCE_SHA256 =
  "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599"
export const SCHEMA_VERSION = 1

export interface Target {
  readonly name: string
  readonly bunTarget: string
}

/** The Artifact Contract's exact target matrix. */
export const TARGETS: ReadonlyArray<Target> = [
  { name: "linux-x64-glibc", bunTarget: "bun-linux-x64" },
  { name: "linux-x64-musl", bunTarget: "bun-linux-x64-musl" },
]

export interface ArchiveMember {
  readonly path: string
  readonly mode: number
  readonly executable: boolean
}

/** Exactly the files each archive contains, with their normalized modes. */
export const ARCHIVE_MEMBERS: ReadonlyArray<ArchiveMember> = [
  { path: "bin/swain", mode: 0o755, executable: true },
  { path: "libexec/rg", mode: 0o755, executable: true },
  { path: "manifest.json", mode: 0o644, executable: false },
  { path: "share/licenses/ripgrep/LICENSE-MIT", mode: 0o644, executable: false },
  { path: "share/licenses/ripgrep/UNLICENSE", mode: 0o644, executable: false },
]

// --- Pure helpers ------------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const isPlainSemver = (version: string): boolean => SEMVER.test(version)

export const isGitCommit = (commit: string): boolean => /^[0-9a-f]{40}$/.test(commit)

export const archiveName = (version: string, target: string): string =>
  `swain-v${version}-${target}.tar.gz`

export interface Manifest {
  readonly schemaVersion: number
  readonly swainVersion: string
  readonly gitCommit: string
  readonly target: string
  readonly bunVersion: string
  readonly ripgrepVersion: string
  readonly ripgrepSourceSha256: string
}

export const buildManifest = (version: string, commit: string, target: string): Manifest => ({
  schemaVersion: SCHEMA_VERSION,
  swainVersion: version,
  gitCommit: commit,
  target,
  bunVersion: BUN_VERSION,
  ripgrepVersion: RIPGREP_VERSION,
  ripgrepSourceSha256: RIPGREP_SOURCE_SHA256,
})

export const serializeManifest = (manifest: Manifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`

/** One `<sha256>  <name>` line per archive, sorted by filename. */
export const buildChecksumIndex = (
  entries: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
): string =>
  `${[...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.name}`)
    .join("\n")}\n`

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")

/** Locates a GNU tar binary (`gtar` or a GNU `tar`); undefined if neither. */
export const findGnuTar = (): string | undefined => {
  for (const bin of ["gtar", "tar"]) {
    try {
      if (execFileSync(bin, ["--version"], { encoding: "utf8" }).includes("GNU tar")) return bin
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/**
 * Assembles a normalized `.tar.gz` from a staged directory: GNU tar sorts paths,
 * zeroes owner/group, and pins every mtime to the source epoch; zlib emits a
 * gzip header with no name and mtime 0. Identical staged inputs therefore
 * produce byte-identical archives.
 */
export const assembleArchive = (opts: {
  readonly tar: string
  readonly stageDir: string
  readonly outPath: string
  readonly epoch: number
}): void => {
  const tarball = execFileSync(
    opts.tar,
    [
      "--format=gnu",
      "--sort=name",
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      `--mtime=@${opts.epoch}`,
      "-C",
      opts.stageDir,
      "-cf",
      "-",
      ...ARCHIVE_MEMBERS.map((member) => member.path),
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  )
  writeFileSync(opts.outPath, gzipSync(tarball, { level: 9 }))
}

// --- Build pipeline ----------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")
const SWAIN_ENTRY = join(REPO_ROOT, "packages", "tui", "bin", "swain.tsx")

interface Args {
  readonly version: string
  readonly commit: string
  readonly targets: ReadonlyArray<Target>
  readonly outDir: string
}

const die = (message: string): never => {
  console.error(`build-release: ${message}`)
  process.exit(1)
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  let version: string | undefined
  let commit: string | undefined
  let target: string | undefined
  let all = false
  let outDir = join(REPO_ROOT, "dist")
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--version") version = argv[++i]
    else if (arg === "--commit") commit = argv[++i]
    else if (arg === "--target") target = argv[++i]
    else if (arg === "--all") all = true
    else if (arg === "--out") outDir = resolve(argv[++i] ?? "")
    else die(`unknown argument: ${arg}`)
  }
  if (!version || !isPlainSemver(version)) die(`--version must be plain SemVer (got ${version})`)
  if (!commit || !isGitCommit(commit)) die(`--commit must be a 40-char hex SHA (got ${commit})`)
  if (all && target) die("pass either --target or --all, not both")
  if (!all && !target) die("pass --target <name> or --all")
  const targets = all ? TARGETS : TARGETS.filter((candidate) => candidate.name === target)
  if (targets.length === 0) die(`unknown target: ${target}`)
  return { version: version as string, commit: commit as string, targets, outDir }
}

/** Downloads, digest-verifies, and extracts `rg` plus its licenses once. */
const prepareRipgrep = async (cacheDir: string): Promise<{ rg: string; licenses: string }> => {
  mkdirSync(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, RIPGREP_ASSET)
  const response = await fetch(RIPGREP_URL)
  if (!response.ok) die(`failed to download ripgrep: ${response.status} ${response.statusText}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = sha256(bytes)
  if (digest !== RIPGREP_SOURCE_SHA256) {
    die(`ripgrep digest mismatch: expected ${RIPGREP_SOURCE_SHA256}, got ${digest}`)
  }
  writeFileSync(archivePath, bytes)
  const extractDir = join(cacheDir, "extracted")
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  execFileSync("tar", ["-xzf", archivePath, "-C", extractDir])
  const inner = join(extractDir, `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl`)
  const rg = join(inner, "rg")

  // Early tracer: the musl-static PIE `rg` must run under the (glibc) build host
  // before any target is packaged, proving the sidecar is libc-independent.
  let trace: string
  try {
    trace = execFileSync(rg, ["--version"], { encoding: "utf8" })
  } catch (error) {
    return die(`ripgrep tracer could not run the extracted rg: ${(error as Error).message}`)
  }
  if (!trace.startsWith(`ripgrep ${RIPGREP_VERSION}`)) {
    die(`ripgrep tracer failed: expected "ripgrep ${RIPGREP_VERSION}", got "${trace.trim()}"`)
  }
  return { rg, licenses: inner }
}

const compileSwain = (bunTarget: string, version: string, outFile: string): void => {
  execFileSync(
    "bun",
    [
      "build",
      SWAIN_ENTRY,
      "--compile",
      `--target=${bunTarget}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--define",
      `__SWAIN_VERSION__=${JSON.stringify(version)}`,
      "--outfile",
      outFile,
    ],
    { stdio: "inherit" },
  )
}

const stageTarget = (opts: {
  target: Target
  version: string
  commit: string
  rg: string
  licenses: string
  stageDir: string
}): void => {
  const { stageDir } = opts
  mkdirSync(join(stageDir, "bin"), { recursive: true })
  mkdirSync(join(stageDir, "libexec"), { recursive: true })
  mkdirSync(join(stageDir, "share", "licenses", "ripgrep"), { recursive: true })

  compileSwain(opts.target.bunTarget, opts.version, join(stageDir, "bin", "swain"))
  cpSync(opts.rg, join(stageDir, "libexec", "rg"))
  writeFileSync(
    join(stageDir, "manifest.json"),
    serializeManifest(buildManifest(opts.version, opts.commit, opts.target.name)),
  )
  cpSync(
    join(opts.licenses, "LICENSE-MIT"),
    join(stageDir, "share", "licenses", "ripgrep", "LICENSE-MIT"),
  )
  cpSync(
    join(opts.licenses, "UNLICENSE"),
    join(stageDir, "share", "licenses", "ripgrep", "UNLICENSE"),
  )

  for (const member of ARCHIVE_MEMBERS) chmodSync(join(stageDir, member.path), member.mode)
}

const existsWithEntries = (dir: string): boolean => {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))

  if (Bun.version !== BUN_VERSION) die(`expected Bun ${BUN_VERSION}, running ${Bun.version}`)
  const tar = findGnuTar()
  if (!tar) die("GNU tar is required (install gnu-tar / gtar)")
  if (existsWithEntries(args.outDir)) die(`output directory ${args.outDir} is not empty`)

  const epoch = Number(
    execFileSync("git", ["show", "-s", "--format=%ct", args.commit], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim(),
  )
  if (!Number.isInteger(epoch)) die(`could not resolve commit timestamp for ${args.commit}`)

  mkdirSync(args.outDir, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), "swain-release-"))
  try {
    const { rg, licenses } = await prepareRipgrep(join(work, "ripgrep"))
    const checksums: Array<{ name: string; sha256: string }> = []
    for (const target of args.targets) {
      const stageDir = join(work, "stage", target.name)
      stageTarget({ target, version: args.version, commit: args.commit, rg, licenses, stageDir })
      const name = archiveName(args.version, target.name)
      const outPath = join(args.outDir, name)
      assembleArchive({ tar: tar as string, stageDir, outPath, epoch })
      checksums.push({ name, sha256: sha256(readFileSync(outPath)) })
      console.log(`built ${name}`)
    }
    writeFileSync(join(args.outDir, "checksums.txt"), buildChecksumIndex(checksums))
    console.log(`wrote ${checksums.length} archive(s) and checksums.txt to ${args.outDir}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
