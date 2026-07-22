# Release Artifact Publishing Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Publish checksummed, versioned Linux archives containing a standalone Swain executable and its `rg` runtime dependency so clean Harbor/Pier task containers can install an exact release without Bun.

**Architecture:** A typed release builder cross-compiles Swain for Linux x64 glibc and musl, packages the matching executable with a static ripgrep sidecar, licenses, and a machine-readable manifest, then produces normalized archives and a checksum index. Semantic-release runs on `main`, derives versions from conventional commits, invokes the builder, and attaches the artifacts to a GitHub Release. This spec deliberately stops at the artifact contract; human-facing install / uninstall scripts, shell profile changes, and other platform-specific packaging remain follow-on work in `specs/draft/binary-release.md`.

**Tech Stack:** Bun 1.3.14, TypeScript, Bash, GNU tar/gzip, ripgrep 15.1.0, GitHub Actions, GitHub Releases, semantic-release 25.0.8.

---

## Current Context

- `swain exec` and build-time version injection already exist from `specs/0009-headless-exec.md`; do not reimplement either command.
- `packages/core/src/tools/ripgrep.ts` currently executes `rg` from `PATH`. A compiled Swain executable is therefore incomplete in a clean container.
- Harbor and Pier install agents inside Linux container images defined by the benchmark / eval harness. This container's CPU/libc determines which binary runs, not the developer's host OS/
- The initial eval infrastructure needs Linux x64 only. Publish both libc variants:

  | Public target | Bun target | Intended containers |
  | --- | --- | --- |
  | `linux-x64-glibc` | `bun-linux-x64` | Debian, Ubuntu, and other glibc images |
  | `linux-x64-musl` | `bun-linux-x64-musl` | Alpine and other musl images |

- Both archives may use ripgrep's `ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz` (latest stable release at time of writing): its `rg` is static PIE and runs independently of the container libc. Pin its upstream SHA-256 as `1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599`.
- “Reproducible” means pinned inputs and an operationally repeatable build. Normalize archive metadata and report same-run byte differences, but do not block releases on an unproven cross-machine bit-for-bit guarantee from Bun.
- Release publication is automatic from `main` via `semantic-release`. Release notes are sufficient for this phase; do not add changelog commits or a release PAT requirement.
- The release build downloads the pinned ripgrep asset from GitHub at build time; this assumes upstream availability. A transient outage fails `prepare` before the tag push, so it is a safe fail-and-retry — not worth caching infra at this stage.

## Artifact Contract

For semantic version `X.Y.Z`, publish:

```text
swain-vX.Y.Z-linux-x64-glibc.tar.gz
swain-vX.Y.Z-linux-x64-musl.tar.gz
checksums.txt
```

Each archive contains exactly:

```text
bin/swain
libexec/rg
manifest.json
share/licenses/ripgrep/LICENSE-MIT
share/licenses/ripgrep/UNLICENSE
```

`manifest.json` records:

```json
{
  "schemaVersion": 1,
  "swainVersion": "X.Y.Z",
  "gitCommit": "<40-character SHA>",
  "target": "linux-x64-glibc",
  "bunVersion": "1.3.14",
  "ripgrepVersion": "15.1.0",
  "ripgrepSourceSha256": "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599"
}
```

`checksums.txt` contains one SHA-256 line per final archive, sorted by filename. No `latest` URL is part of the installation contract: consumers pin the release version and verify the selected archive against this index.

## Reference Sources

- Bun standalone/cross-compiled executables: <https://bun.com/docs/bundler/executables>
- ripgrep 15.1.0 release assets: <https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0>
- semantic-release configuration: <https://semantic-release.gitbook.io/semantic-release/usage/configuration>

## Task 1: Make the ripgrep sidecar discoverable

**Objective:** Let a packaged Swain use its private `rg` without changing the user's/container's `PATH`, while source runs retain the current system fallback.

**Files:**

- Modify: `packages/core/src/tools/ripgrep.ts`
- Modify: `packages/core/test/tools-filesystem.test.ts`
- Modify: `packages/tui/bin/swain.tsx`
- Create: `packages/tui/src/sidecars.ts`
- Create: `packages/tui/test/sidecars.test.ts`

**Step 1: Write failing tests**

- In `tools-filesystem.test.ts`, place a fake executable at a temporary path, set `SWAIN_RG_PATH`, and prove `Glob`/`Grep` invoke it instead of the system `rg`.
- Prove an unset `SWAIN_RG_PATH` retains `Command.make("rg", ...)` behavior.
- In `sidecars.test.ts`, cover a compiled-style layout (`bin/swain` beside `libexec/rg`), a missing sidecar, and an explicit caller-provided `SWAIN_RG_PATH` that must not be overwritten.

**Step 2: Verify the tests fail**

Run:

```bash
bun test packages/core/test/tools-filesystem.test.ts packages/tui/test/sidecars.test.ts
```

Expected: FAIL because the resolver and environment override do not exist.

**Step 3: Implement the minimal runtime contract**

- Add a pure resolver in `sidecars.ts` that derives `../libexec/rg` from `process.execPath`, returns it only when it is a file, and leaves an existing `SWAIN_RG_PATH` untouched.
- Call the resolver once in `packages/tui/bin/swain.tsx` before `runCli()`.
- Change `runRipgrep()` to execute `process.env.SWAIN_RG_PATH ?? "rg"`.
- Keep the sidecar private: never prepend `libexec` to `PATH` and never fall back from an explicitly configured but broken `SWAIN_RG_PATH`.

**Step 4: Verify**

Run the Task 1 test command again. Expected: PASS.

**Commit:** `build: support packaged ripgrep sidecar`

## Task 2: Build normalized Linux release archives

**Objective:** Produce the two exact archives, manifests, licenses, and checksum index from a clean checkout.

**Files:**

- Create: `packages/tui/scripts/build-release.ts`
- Create: `packages/tui/test/release.test.ts`
- Modify: `packages/tui/package.json`
- Modify: `package.json`

**Step 1: Write failing tests**

Test the builder's exported pure pieces before shelling out:

- target table contains exactly the two Artifact Contract rows;
- version must be plain SemVer and commit must be a 40-character hex SHA;
- ripgrep version, URL, and source checksum are fixed constants;
- manifest serialization is stable and target-specific;
- archive member list and executable modes are exact;
- checksum index is sorted, contains both archives once, and changes if an archive changes;
- repeated archive assembly from identical staged files normalizes file order, uid/gid, modes, mtimes, and gzip headers.

**Step 2: Verify the tests fail**

Run:

```bash
bun test packages/tui/test/release.test.ts
```

Expected: FAIL because the release builder does not exist.

**Step 3: Implement the builder**

Add `bun run build:release -- --version X.Y.Z --commit <sha> [--target <name>|--all]` with these rules:

1. Refuse a dirty/missing version argument, unknown target, wrong Bun version, missing GNU archive tools, or a pre-existing non-empty output directory.
2. Download the pinned ripgrep archive once into a temporary/cache directory, verify the hard-coded upstream digest before extraction, and copy only `rg` plus its two license files. Immediately after extraction, exec the extracted `rg --version` on the build host and refuse to continue unless it prints `ripgrep 15.1.0` — this is the early tracer that the musl-static PIE runs under the glibc CI host before any downstream target is built.
3. Compile `packages/tui/bin/swain.tsx` with `bun build --compile`, the selected Bun target, autoload disabled, and `__SWAIN_VERSION__` defined as `X.Y.Z`.
4. Stage only the Artifact Contract files. Set executable files to `0755` and data/license files to `0644`.
5. Use the source commit timestamp as `SOURCE_DATE_EPOCH`; archive with sorted paths, numeric owner/group `0`, normalized timestamps, and gzip's timestamp/name fields disabled.
6. Generate the per-target manifest before archiving and `checksums.txt` after both archives exist.
7. Never commit `dist/`, caches, downloaded archives, or executables.

**Step 4: Verify locally**

The `0.0.0-test` build writes archives to `dist/` for verification only; nothing here publishes them (publication is Task 3, on main).

Run:

```bash
bun run build:release -- --version 0.0.0-test --commit "$(git rev-parse HEAD)" --all
tar -tzf dist/swain-v0.0.0-test-linux-x64-glibc.tar.gz
shasum -a 256 -c dist/checksums.txt
bun test packages/tui/test/release.test.ts
```

Expected: both archives exist, the listing matches the contract, both checksums pass, and tests pass.

**Commit:** `build: package linux release artifacts`

## Task 3: Publish artifacts with semantic-release

**Objective:** Derive versions from conventional commits on `main` and publish one GitHub Release containing the complete verified artifact set.

**Files:**

- Create: `.releaserc.json`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `AGENTS.md`
- Modify: `packages/tui/test/release.test.ts`

**Pinned development dependencies:**

```text
semantic-release                         25.0.8
@semantic-release/commit-analyzer        13.0.1
@semantic-release/release-notes-generator 14.1.1
@semantic-release/exec                   7.1.0
@semantic-release/github                 12.0.9
conventional-changelog-conventionalcommits 9.1.0
```

`conventional-changelog-conventionalcommits` is held at 9.x: 10.x moved to the
`@conventional-changelog/template` engine, which is incompatible with the
`conventional-changelog-writer@8` bundled by `release-notes-generator@14` and
silently produces empty release notes.

Do not add `@semantic-release/changelog` or `@semantic-release/git`: release notes live on the GitHub Release, avoiding generated commits back to protected `main`.

**Step 1: Add release-config tests/checks**

- Add a package script that runs semantic-release in dry-run mode.
- Validate `.releaserc.json` declares only `main`, uses the conventional-commits preset, invokes Task 2 with `${nextRelease.version}` and the checked-out SHA, and uploads exactly the two archives plus `checksums.txt`.
- Ensure all semantic-release packages are exact versions in `package.json` and `bun.lock`.

**Step 2: Add the release workflow**

The workflow must:

1. trigger on pushes to `main` and use a concurrency group that does not cancel an in-progress publication;
2. check out full history/tags (`fetch-depth: 0`);
3. install Bun from `package.json`, Node 24 for semantic-release, and frozen dependencies;
4. run `bun run format:check`, `bun run typecheck`, and `bun run test` before release analysis;
5. use `GITHUB_TOKEN` with only `contents: write`, `issues: write`, and `pull-requests: write`;
6. run semantic-release via Node, not Bun runtime compatibility assumptions;
7. let `@semantic-release/exec` build/verify the full artifact matrix during `prepare`;
8. let `@semantic-release/github` create the tag/release and upload the three expected assets;
9. be a successful no-op when the commit range does not warrant a release.

**Step 3: Document the versioning contract**

Add a short `AGENTS.md` note: conventional commit type determines semantic version, tags/GitHub Releases are authoritative, `package.json` stays private `0.0.0`, and release-input pins must be updated atomically. Include the partial-release recovery procedure: semantic-release pushes the `vX.Y.Z` tag before uploading assets and never republishes an existing version, so if a release job fails mid-publish the maintainer must delete both the remote tag and the GitHub Release before re-running — deleting the Release alone leaves the tag, which makes semantic-release skip the version. The failing job auto-opens a tracking issue (`issues: write`).

**Step 4: Verify without publishing**

Run:

```bash
bun install --frozen-lockfile
bun run release:dry-run
```

Expected: semantic-release resolves `main`, analyzes commits, prints the proposed version/notes, and performs no tag, release, or asset upload.

**Commit:** `ci: publish semantic release artifacts`

## Task 4: Prove both archives in clean containers

**Objective:** Fail pull requests early when either released target cannot start or the bundled sidecar is incomplete.

**Files:**

- Create: `packages/tui/scripts/smoke-release.sh`
- Modify: `packages/tui/test/release.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

**Step 1: Add black-box smoke coverage**

- Build `0.0.0-test` artifacts on Linux CI.
- Extract the glibc archive into a digest-pinned Debian slim container and the musl archive into a digest-pinned Alpine container.
- In each container, with Bun absent and an empty/minimal `PATH`, assert:
  - `bin/swain --version` prints `0.0.0-test`;
  - `bin/swain --help` exits `0`;
  - `libexec/rg --version` prints `ripgrep 15.1.0`;
  - `manifest.json` names the matching target;
  - the checksum index verifies before extraction.
- Add a negative test that deliberately pairs the glibc binary with Alpine and confirms the smoke harness reports a target mismatch rather than silently accepting it.

**Step 2: Wire CI**

Keep the normal TypeScript checks. Add one Linux artifact-smoke job on pull requests; do not run semantic-release or publish from pull requests.

**Step 3: Document the artifact boundary**

- `README.md`: document asset names, supported containers, checksum verification, and that these are machine-consumed archives—not yet the public curl installer.
- `ARCHITECTURE.md`: note the standalone executable plus private `rg` sidecar and the `SWAIN_RG_PATH` resolution contract.

**Step 4: Full verification**

Run:

```bash
bun run format:check
bun run typecheck
bun run test
bun run build:release -- --version 0.0.0-test --commit "$(git rev-parse HEAD)" --all
bash packages/tui/scripts/smoke-release.sh dist 0.0.0-test
```

Expected: all commands exit `0`; both clean-container smokes pass.

**Commit:** `test: smoke standalone linux artifacts`

## Risks and Deliberate Deferrals

- **ARM containers:** fail before download/install with a supported-target message. Add `linux-arm64-glibc` only after an actual Harbor/Pier environment requires it; `linux-arm64-musl` additionally needs a maintained ripgrep build.
- **Bit-for-bit reproducibility:** archive metadata is normalized (a unit test asserts identical staged files produce identical archives), but Bun executable determinism is not asserted across builds or independent machines in this phase; the double-build cross-check is deferred to the phase that actually guarantees reproducibility.
- **Human installation:** no `curl | bash`, shell profile edits, install root policy, upgrades, or uninstall/purge behavior here.
- **macOS/Windows:** not required inside Harbor/Pier Linux task containers.
- **Artifact immutability:** semantic-release never republishes an existing version. Consumers still pin version plus SHA-256 rather than trusting a floating asset URL.

## Post-Implementation Changes

- The Task 4 verifier shipped as `packages/tui/scripts/verify-release.sh` (CI job `verify-artifacts`), not the planned `smoke-release.sh`.
- The release build stubs `react-devtools-core` (ink's dev-only dynamic import) via a Bun resolver plugin so the compiled binary bundles cleanly.
- The musl binary is not fully static, so the Alpine verification installs `libstdc++`/`libgcc` before running it; the README documents the same runtime dependency for consumers.
