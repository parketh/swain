# Binary Release Implementation Plan (Draft)

> Deferred follow-on to headless exec. Not needed to build or validate exec, nor to run
> Harbor locally where the environment is under your control (Harbor can invoke
> `bun run packages/tui/bin/swain.tsx exec ...` or a shell alias). Required only once evals
> run inside a **clean container** with no Bun present, where `swain` must exist on PATH.
> Promote to a numbered spec before that milestone.

**Goal:** Distribute Swain as verified standalone macOS/Linux release archives with curl-based install and uninstall scripts, driven by a semantic-release pipeline on `main`.

**Tech Stack:** Bun 1.3.14, TypeScript, Bash, GitHub Actions, GitHub Releases, semantic-release, ripgrep 15.1.0.

**Scope decision (minimal v1):** Ship only the targets actually run — `darwin-arm64` (primary, Harbor on Apple Silicon), `darwin-x64`, `linux-x64-glibc`, `linux-arm64-glibc`. All four have upstream ripgrep release artifacts and are near-free Bun cross-compiles. Explicitly **excluded from v1** (add on first real report):

- **Pre-AVX2 (baseline) x64 variants** — removes AVX2 CPU probing from the installer. Target users run post-2015 x64.
- **musl variants** — removes the arm64-musl-from-source CI build, the single most complex build step. Add if evals move to Alpine-based containers.

---

## Current Context

- `Glob` and `Grep` shell out to `rg` (`packages/core/src/tools/ripgrep.ts` hardcodes `Command.make("rg", ...)`); a standalone Swain executable alone is therefore not a complete fresh-container install.
- The repository has no versioned build, release workflow, release assets, install script, or uninstall script.
- Headless exec adds `version.ts` returning `dev` in source runs and a `swain --version` command. This spec injects the real tag at build time and wires the private ripgrep sidecar via `SWAIN_RG_PATH`.

## Resolved Product Decisions

### Distribution contract

- Root executable scripts: `install` and `uninstall`.
- Initial documented routes:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/parketh/swain/refs/heads/main/install | bash
  curl -fsSL https://raw.githubusercontent.com/parketh/swain/refs/heads/main/uninstall | bash
  ```

- Install the latest stable `v*` GitHub release by default. Support `--version X.Y.Z`; embed the tag so `swain --version` prints `X.Y.Z`.
- Support macOS and Linux on x64 and arm64 (**glibc only in v1**). Windows is out of scope for curl/Bash v1.
- Default install root: `${SWAIN_INSTALL_DIR:-$HOME/.swain}`:
  - `bin/swain`
  - `libexec/rg`
  - `share/licenses/ripgrep/LICENSE-MIT`
  - `share/licenses/ripgrep/UNLICENSE`
- Only `$SWAIN_INSTALL_DIR/bin` is added to PATH. The private `rg` sidecar must not shadow a user's system `rg`.
- The installer detects OS/architecture and Rosetta translation; supports latest and pinned versions; performs idempotent upgrades; sets up the shell PATH; honors `--no-modify-path`; and appends to `$GITHUB_PATH` under GitHub Actions. It additionally verifies SHA-256 checksums and ships a matching uninstaller. (No musl/AVX2 detection in v1.)
- Release archives contain Swain, pinned ripgrep 15.1.0, and the two ripgrep license files, sourced from upstream ripgrep release artifacts and verified against their checksums.
- The uninstaller removes only installer-owned binaries/licenses and the exact marked PATH stanza by default. It preserves `${XDG_CONFIG_HOME:-$HOME/.config}/swain` credentials, settings, and sessions.
- `uninstall --purge --yes` additionally removes Swain's config/data directory. `--purge` without `--yes` must fail in non-interactive use rather than deleting data implicitly.

## Reference Behavior

- Bun standalone and cross-compiled executables: <https://bun.com/docs/bundler/executables>
- semantic-release configuration and plugins: <https://semantic-release.gitbook.io/semantic-release>
- Pinned ripgrep release: <https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0>

## Proposed Layout

```text
install
uninstall
.releaserc.json
CHANGELOG.md
.github/workflows/release.yml
packages/tui/
  scripts/
    build-release.ts
  test/
    install.test.ts
    release.test.ts
```

---

## Task 1: Build versioned standalone release archives

**Objective:** Produce self-contained Swain archives for the four supported targets, including a private ripgrep sidecar and licenses.

**Files:**

- Create: `packages/tui/scripts/build-release.ts`
- Create: `packages/tui/test/release.test.ts`
- Modify: `packages/tui/src/cli.ts`
- Modify: `packages/core/src/tools/ripgrep.ts`
- Modify: `packages/core/test/tools-filesystem.test.ts`
- Modify: `packages/tui/package.json`
- Modify: `package.json`

**Design:**

1. Add a typed release-target table mapping public asset names to Bun compile targets and ripgrep targets: `darwin-arm64`, `darwin-x64`, `linux-x64-glibc`, `linux-arm64-glibc`.
2. Compile `packages/tui/bin/swain.tsx` with `bun build --compile`, the exact Bun version from `package.json`, dotenv/bunfig autoload disabled, and the normalized tag injected into `version.ts`.
3. Package this layout in each `swain-<target>.tar.gz`:

   ```text
   bin/swain
   libexec/rg
   share/licenses/ripgrep/LICENSE-MIT
   share/licenses/ripgrep/UNLICENSE
   ```

4. Pin ripgrep at 15.1.0. Download and verify each target's upstream archive against its checksum. (No from-source builds in v1 — every v1 target has an upstream artifact.)
5. Add `SWAIN_RG_PATH` support to `runRipgrep()`, falling back to `rg` for source development/system installs. At CLI startup, set it only when the expected private sidecar relative to the installed executable exists. Do not prepend the sidecar directory to the process PATH.
6. Generate `checksums.txt` covering every final Swain archive.
7. Keep `dist/` ignored and make builds reproducible from a clean checkout. No generated binary is committed.

**Tests first:**

- Every public target maps to a valid Bun target and an existing upstream ripgrep artifact.
- Archive layout and executable modes are exact.
- A compiled host binary returns the injected version and help without Bun installed in its runtime PATH.
- `runRipgrep()` prefers an explicit private path and retains system fallback for source runs.
- A checksum changes when any archive byte changes.
- A native archive extracts and passes `swain --version`, `swain --help`, and `rg --version` smoke tests.

**Verify:**

```bash
bun test packages/tui/test/release.test.ts packages/core/test/tools-filesystem.test.ts
bun run build:release -- --target host --version 0.0.0-test
./dist/swain-host/bin/swain --version
./dist/swain-host/libexec/rg --version
```

**Commit:** `build: package standalone swain releases`

## Task 2: Add the checksummed installer

**Objective:** Install or upgrade a selected release without requiring Bun or changing unrelated user state.

**Files:**

- Create: `install`
- Create: `packages/tui/test/install.test.ts`

**Installer behavior:**

1. Use Bash with `set -euo pipefail` and a cleanup trap around a `mktemp -d` directory.
2. Support:

   ```text
   --help
   --version X.Y.Z
   --no-modify-path
   SWAIN_INSTALL_DIR=/custom/root
   SWAIN_RELEASE_BASE_URL=<test-or-mirror-url>
   ```

3. Normalize `uname` output and Rosetta translation into exactly one Task 1 asset name. Reject unsupported OS/architecture combinations before downloading. (No musl/AVX2 branches in v1.)
4. Download the selected archive and matching `checksums.txt` over HTTPS. Verify the selected line with `sha256sum`, `shasum -a 256`, or `openssl dgst -sha256`; fail closed if no verifier exists or the digest mismatches.
5. Extract to a staging directory and run staged `bin/swain --version` plus `libexec/rg --version` before replacing the installed files.
6. Install atomically where practical: prepare complete files in the destination filesystem, then rename them into place. Preserve the previous working install if download, checksum, extraction, or smoke validation fails.
7. Use a marked, idempotent shell stanza:

   ```text
   # >>> swain >>>
   export PATH="$HOME/.swain/bin:$PATH"
   # <<< swain <<<
   ```

   Detect the user's shell and write to the appropriate profile across zsh, bash, fish, and ash. `--no-modify-path` prints the manual export instead. In GitHub Actions, append the bin directory to `$GITHUB_PATH`.
8. Reinstalling the same version is a successful no-op. Installing another version replaces only installer-owned release files.

**Black-box tests:**

- Use temporary HOME/XDG directories and a local fake release base; never hit the network.
- Test every target-selection branch with stubbed `uname` and Rosetta probes.
- Latest and pinned URLs select the expected archive.
- Valid checksums install; mismatches and missing verification tools fail without changing the prior binary.
- PATH insertion is exact and idempotent; `--no-modify-path` writes nothing.
- A failed staged smoke leaves the prior install usable.

**Verify:**

```bash
bun test packages/tui/test/install.test.ts -t install
bash -n install
```

**Commit:** `feat: add standalone installer`

## Task 3: Add the data-safe uninstaller

**Objective:** Remove installer-owned release files and PATH configuration without deleting user data unless explicitly purged.

**Files:**

- Create: `uninstall`
- Modify: `packages/tui/test/install.test.ts`

**Uninstaller behavior:**

1. Use the same install-root and shell-profile resolution as `install`; keep shared shell logic textually small rather than introducing a sourced remote helper.
2. Remove only:
   - `bin/swain`;
   - `libexec/rg`;
   - the bundled ripgrep licenses;
   - now-empty installer-owned directories;
   - the exact `# >>> swain >>>` / `# <<< swain <<<` PATH block.
3. Preserve config/auth/sessions by default and print their retained path.
4. `--purge --yes` additionally removes `${XDG_CONFIG_HOME:-$HOME/.config}/swain`. Reject `--purge` without `--yes` in non-interactive use. Resolve and display the exact purge target before deletion; never derive a recursive target from an empty HOME/XDG value.
5. Repeated uninstall is a successful no-op.

**Black-box tests:**

- Default uninstall removes Swain/sidecar/PATH stanza and preserves config, auth, and sessions byte-for-byte.
- `--purge --yes` removes only the validated Swain config directory.
- `--purge` without confirmation fails and preserves everything.
- Custom install roots work when the same `SWAIN_INSTALL_DIR` is supplied.
- An unrelated PATH line or neighboring shell configuration is untouched.
- Repeated uninstall returns `0`.

**Verify:**

```bash
bun test packages/tui/test/install.test.ts -t uninstall
bash -n uninstall
```

**Commit:** `feat: add data-safe uninstaller`

## Task 4: Publish releases and document install workflows

**Objective:** Automate versioning, changelog, and immutable release publication with semantic-release, and document the supported install/eval paths.

**Files:**

- Create: `.github/workflows/release.yml`
- Create: `.releaserc.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `.env.example`

**semantic-release configuration (`.releaserc.json`):**

1. Release only from `main`. Pin every semantic-release dependency exactly (no ranges), as dev dependencies.
2. Plugin chain, in order:
   - `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator` on the `conventionalcommits` preset.
   - `@semantic-release/changelog` to maintain `CHANGELOG.md`.
   - `@semantic-release/exec` with a `prepareCmd` that builds the full Task 1 matrix at the computed version: `bun run build:release -- --all --version ${nextRelease.version}`.
   - `@semantic-release/github` to create the tag + GitHub Release and upload every `dist/*.tar.gz` plus `checksums.txt` as assets.
   - `@semantic-release/git` to commit the updated `CHANGELOG.md` (and nothing else) back to `main` with a `chore(release):` message.
3. The version flows one way: semantic-release computes it, `prepareCmd` injects it into `version.ts` via the build script, and the same value tags the release. Nothing reads a version from `package.json`.

**Release workflow:**

1. Trigger on pushes to `main`; grant `contents: write` and `issues:`/`pull-requests: write`. Add a concurrency group so only one release runs at a time.
2. Install the exact Bun version from root `package.json`, then run frozen install, format check, typecheck, and non-live tests before releasing.
3. Run `bunx semantic-release`. On a release-worthy range it builds the matrix, verifies every expected artifact/checksum exists exactly once, smoke-tests host binaries, and publishes exactly one immutable Release; on a non-release range it is a clean no-op.
4. `GITHUB_TOKEN` suffices for the Release; committing `CHANGELOG.md` back to a protected `main` requires a PAT or a ruleset bypass — call this out in the workflow.
5. On pull requests, run `bunx semantic-release --dry-run`.
6. Extend normal CI with the cheap host compile/`--help`/`--version` smoke.

**AGENTS.md — versioning section:** record (without duplicating code): semantic-release drives versions from conventional commits on `main`; the version lives in tags + `CHANGELOG.md`, never `package.json`; `BREAKING CHANGE:` footers force a major and document the break; Bun is one version across `packageManager`/`@types/bun`/CI, bumped atomically; the ripgrep pin and its checksums live in the release build script and are bumped manually.

**README documentation:** curl install/uninstall commands and the trust implication of piping remote shell code; pinned install example; `--no-modify-path`, `SWAIN_INSTALL_DIR`, upgrade, default uninstall, and purge behavior; supported OS/architecture matrix (v1: darwin arm64/x64, linux glibc arm64/x64); Harbor adapter sketch using `exec_as_agent(..., command="swain exec --permission-mode auto --model ... <quoted instruction>")`.

**Architecture updates:** record semantic-release-driven versioning, release packaging, the private ripgrep sidecar, and the tag/checksum trust boundary.

**Verify:**

```bash
bun run format:check
bun run typecheck
bun test packages/core/test packages/tui/test --path-ignore-patterns='**/live/**'
bash -n install
bash -n uninstall
```

Then one clean-container smoke using a local release archive:

```bash
SWAIN_RELEASE_BASE_URL=<local-test-server> bash install --version 0.0.0-test --no-modify-path
"$HOME/.swain/bin/swain" --version
"$HOME/.swain/bin/swain" exec --permission-mode plan --model <configured-model> "Inspect the workspace"
bash uninstall
```

**Commit:** `docs: document distribution`

---

## Risks and Mitigations

- **Compiled-binary incompatibility:** build explicit architecture variants and smoke-test native artifacts. (v1 is glibc-only; do not treat glibc and musl as interchangeable if musl is added later.)
- **Missing ripgrep on fresh images:** package a pinned private sidecar and direct only Swain's search tools to it.
- **Supply-chain substitution:** publish immutable tagged archives, verify archive checksums in the installer, verify upstream ripgrep inputs in release CI, and include licenses.
- **Broken upgrade:** validate in staging and replace installer-owned files only after archive/version/sidecar checks pass.
- **Release automation misfires:** require conventional commits, validate with `semantic-release --dry-run` on PRs, keep the plugin chain minimal. Committing `CHANGELOG.md` back to a protected `main` needs a PAT or ruleset bypass, not the default `GITHUB_TOKEN`.
- **Destructive uninstall:** preserve config by default, require `--purge --yes`, validate the exact config target, and test unrelated files remain untouched.

## Explicit Non-Goals

- Pre-AVX2 baseline and musl targets (deferred until a real report).
- Windows/PowerShell distribution.
- Homebrew, npm, Bun registry, Nix, or container-image publication.
- Pre-release, canary, or maintenance-branch release channels; semantic-release runs on `main` only.
- Vanity-domain/DNS deployment.
- Bundling Git or a shell; tasks requiring them must provide them in the environment.

## Acceptance Criteria

- A tagged release produces verified archives for all four declared macOS/Linux glibc targets; an extracted archive runs without Bun.
- A fresh supported container can install Swain plus private ripgrep with the root installer and run `swain --version`.
- Default uninstall removes the installed program and PATH stanza while preserving config/auth/sessions; explicit confirmed purge removes only Swain data.
- All targeted tests plus `bun run typecheck` and `bun run format:check` pass.
