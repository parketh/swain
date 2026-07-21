import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  ARCHIVE_MEMBERS,
  archiveName,
  assembleArchive,
  BUN_VERSION,
  buildChecksumIndex,
  buildManifest,
  findGnuTar,
  isGitCommit,
  isPlainSemver,
  RIPGREP_SOURCE_SHA256,
  RIPGREP_URL,
  RIPGREP_VERSION,
  serializeManifest,
  TARGETS,
} from "../scripts/build-release"

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

describe("target table", () => {
  test("contains exactly the two Artifact Contract rows", () => {
    expect(TARGETS).toEqual([
      { name: "linux-x64-glibc", bunTarget: "bun-linux-x64" },
      { name: "linux-x64-musl", bunTarget: "bun-linux-x64-musl" },
    ])
  })
})

describe("input validation", () => {
  test("accepts plain SemVer including a prerelease", () => {
    expect(isPlainSemver("1.2.3")).toBe(true)
    expect(isPlainSemver("0.0.0-test")).toBe(true)
    expect(isPlainSemver("v1.2.3")).toBe(false)
    expect(isPlainSemver("1.2")).toBe(false)
  })

  test("requires a 40-character hex commit SHA", () => {
    expect(isGitCommit(COMMIT)).toBe(true)
    expect(isGitCommit(COMMIT.toUpperCase())).toBe(false)
    expect(isGitCommit(COMMIT.slice(0, 39))).toBe(false)
  })
})

describe("pinned ripgrep constants", () => {
  test("version, URL, and source digest are fixed", () => {
    expect(RIPGREP_VERSION).toBe("15.1.0")
    expect(RIPGREP_SOURCE_SHA256).toBe(
      "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    )
    expect(RIPGREP_URL).toBe(
      "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
    )
  })
})

describe("manifest", () => {
  test("serializes stably and is target-specific", () => {
    const glibc = serializeManifest(buildManifest("1.2.3", COMMIT, "linux-x64-glibc"))
    expect(glibc).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          swainVersion: "1.2.3",
          gitCommit: COMMIT,
          target: "linux-x64-glibc",
          bunVersion: BUN_VERSION,
          ripgrepVersion: "15.1.0",
          ripgrepSourceSha256: RIPGREP_SOURCE_SHA256,
        },
        null,
        2,
      )}\n`,
    )
    // Same inputs reserialize identically; only the target field differs.
    expect(serializeManifest(buildManifest("1.2.3", COMMIT, "linux-x64-glibc"))).toBe(glibc)
    expect(serializeManifest(buildManifest("1.2.3", COMMIT, "linux-x64-musl"))).not.toBe(glibc)
  })
})

describe("archive members", () => {
  test("are exactly the contract files with correct modes", () => {
    expect(ARCHIVE_MEMBERS).toEqual([
      { path: "bin/swain", mode: 0o755, executable: true },
      { path: "libexec/rg", mode: 0o755, executable: true },
      { path: "manifest.json", mode: 0o644, executable: false },
      { path: "share/licenses/ripgrep/LICENSE-MIT", mode: 0o644, executable: false },
      { path: "share/licenses/ripgrep/UNLICENSE", mode: 0o644, executable: false },
    ])
  })

  test("archiveName follows the swain-vX.Y.Z-target convention", () => {
    expect(archiveName("1.2.3", "linux-x64-glibc")).toBe("swain-v1.2.3-linux-x64-glibc.tar.gz")
  })
})

describe("checksum index", () => {
  test("is sorted, lists each archive once, and changes when an archive changes", () => {
    const index = buildChecksumIndex([
      { name: "swain-v1.2.3-linux-x64-musl.tar.gz", sha256: "bbb" },
      { name: "swain-v1.2.3-linux-x64-glibc.tar.gz", sha256: "aaa" },
    ])
    expect(index).toBe(
      "aaa  swain-v1.2.3-linux-x64-glibc.tar.gz\nbbb  swain-v1.2.3-linux-x64-musl.tar.gz\n",
    )
    expect(index.trim().split("\n")).toHaveLength(2)

    const changed = buildChecksumIndex([
      { name: "swain-v1.2.3-linux-x64-musl.tar.gz", sha256: "ccc" },
      { name: "swain-v1.2.3-linux-x64-glibc.tar.gz", sha256: "aaa" },
    ])
    expect(changed).not.toBe(index)
  })
})

// The archive assembly test genuinely shells out to GNU tar; skip it (with a
// note) on hosts that only have bsdtar, but run it fully on Linux CI.
const gnuTar = findGnuTar()
describe("archive assembly", () => {
  test.skipIf(!gnuTar)("normalizes identical staged files to identical archives", () => {
    const root = mkdtempSync(join(tmpdir(), "swain-archive-"))
    try {
      const stage = join(root, "stage")
      for (const member of ARCHIVE_MEMBERS) {
        const abs = join(stage, member.path)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, `contents of ${member.path}`)
        chmodSync(abs, member.mode)
      }
      const a = join(root, "a.tar.gz")
      const b = join(root, "b.tar.gz")
      assembleArchive({ tar: gnuTar as string, stageDir: stage, outPath: a, epoch: 1_700_000_000 })
      assembleArchive({ tar: gnuTar as string, stageDir: stage, outPath: b, epoch: 1_700_000_000 })
      expect(readFileSync(a)).toEqual(readFileSync(b))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
