---
name: release
description: Prepare and publish the personal npm package @wei840222/qmd, including changelog, validation, version/tag preparation, and registry verification. Use only when the user explicitly requests a release or asks about its process.
disable-model-invocation: true
---

# Release @wei840222/qmd

The release artifact is the public personal npm package `@wei840222/qmd` at
`https://registry.npmjs.org/`. Verify that exact package name and registry before
uploading. A Git push or GitHub Release alone does not prove that the npm version
is available.

Use this skill only on an explicit release request. For process questions, explain
the workflow without cutting a version. Follow the user's existing authorization
for commits, pushes, and publication; preparing a release does not authorize a
registry upload. Never read or print authentication files or tokens, switch
accounts, force-push, or bypass failed checks.

## Prerequisites

Work from the repository root. Use Node.js >=24.21.0 and pnpm from `package.json`;
release helpers also require Bash, Git, jq, and Perl. GitHub automation additionally
needs an available authenticated `gh` CLI; do not assume a particular agent tool.
Read `AGENTS.md`, `package.json`, `CHANGELOG.md`, and the current release scripts.
Preserve the remote-only runtime and use mocks/loopback HTTP for model tests.

The fork's development branch is `local`; `scripts/release.sh` accepts `local` or
`main`, and `.github/workflows/ci.yml` currently checks `local`. Inspect the current
branch and configured remotes instead of copying the script's stale final
`git push origin main --tags` suggestion.

## Process

1. **Confirm the target and version** — verify `package.json.name` is
   `@wei840222/qmd`, the npm registry and dist-tag are intended, and the exact
   version is not already published. Prefer an explicit calendar-style version
   such as `2026.10.25`; `patch`/`minor`/`major` only do numeric arithmetic, not
   calendar calculations. Check existing Git tags and released changelog entries.
   Use public registry metadata to distinguish an unpublished version from a
   network failure. Do not overwrite a pre-existing version edit without review.

2. **Gather context and select work** — run
   `.agents/skills/release/scripts/release-context.sh 2026.10.25`, substituting the
   requested version. This helper is read-only. It prints status, the nearest
   reachable tag, commits/files since that tag, Unreleased, and a style reference;
   confirm the tag is a useful release baseline. Commit only reviewed work in
   scope, preserving unrelated changes. The release script requires a clean tree.

3. **Write the changelog** — collect user-visible changes under `[Unreleased]`.
   Require actual new entries, not just a heading or an older same-series entry.
   Explain behavior and compatibility changes, especially index conversion and
   backup requirements. Preview with `scripts/extract-changelog.sh 2026.10.25`.

4. **Validate the release source** — run `pnpm run lint`,
   `pnpm exec tsc -p tsconfig.json --noEmit`, and `pnpm test`; add the relevant
   quality/remote checks from AGENTS. `pnpm test` includes a build-config
   typecheck, unit tests, and package smoke, but not the full-project typecheck.
   Keep dependencies in sync with the frozen lockfile. Outdated dependencies are
   a separate maintenance decision, not an instruction to upgrade them all.
   Commit the reviewed release changes, including the changelog, before step 5.
   If unrelated dirty work remains, preserve it in the original worktree and
   prepare the release from a clean checkout containing the intended commits.

5. **Prepare the local release** — install hooks explicitly when appropriate with
   `.agents/skills/release/scripts/install-hooks.sh`, after reviewing any existing
   hook and the effective hooks directory (shared by linked worktrees unless
   configured otherwise). The helper preserves a replaced hook as a backup.
   Run `scripts/release.sh 2026.10.25` interactively. It performs a frozen install
   (including prepare/build/hooks), previews notes, asks for confirmation,
   renames Unreleased, bumps `package.json`, commits, and creates `v2026.10.25`.
   It does not run the full verification suite or publish to npm. A marketplace
   version is updated only if that legacy file exists. Inspect the resulting
   commit, tag, manifest, and changelog before continuing.

6. **Build and publish the artifact** — rebuild after the release commit so
   `dist/cli/build-info.json` records the tagged commit; run
   `pnpm run test:package` again because the version/commit changed. Pack into a
   temporary directory, inspect its manifest/name/version, files, and CLI version,
   and publish the reviewed artifact through the authorized npm publication route.
   Use the local or GitHub route below; never publish the same version through both.

7. **Verify npm availability** — read public registry metadata for the exact
   `@wei840222/qmd` version and the intended dist-tag. Compare integrity with the
   reviewed tarball for a local publication. Smoke-test the installed package in
   a temporary consumer with temporary config/cache and no real index, API keys,
   model calls, or service restart. A successful upload is not an installation
   check. If upload output is ambiguous, check the registry before retrying.

8. **Report and synchronize** — report package version, dist-tag, commit/tag,
   artifact and installation checks, and any unresolved publication result.
   Push only the intended branch and exact release tag through the approved
   remote/mirror route; never use `--tags`. Check the GitHub publication behavior
   below before pushing a tag. Local CLI installation or systemd deployment is a
   separate action that requires its own authorization.

## Dependency Policy

The manifest currently mixes exact native dependency versions with existing
ranges such as `@typesafe-ai/sdk` and `lru-cache`; do not claim every dependency is
exact-pinned or rewrite ranges during a release. For an approved native dependency
update, keep `sqlite-vec` and its platform packages aligned, update the pnpm
lockfile, and run the relevant package/grammar checks. `pnpm outdated` is an
optional report, not permission to expand the release.

## Publication routes

For an authorized local npm release, use pnpm and the explicit package registry.
The following assumes the reviewed tarball and actual branch have been selected:

```sh
pnpm publish "$release_tarball" --access public --registry https://registry.npmjs.org/ --publish-branch "$release_branch" --tag latest
```

Use the requested dist-tag for a prerelease instead of moving `latest` silently.
Keep Git checks enabled; do not add `--force` or `--no-git-checks` to get past an
error. Let the user handle any login or OTP interaction without exposing secrets.
See the [pnpm publish reference](https://pnpm.io/cli/publish) for supported options.

If the user chooses GitHub automation, `.github/workflows/publish.yml` publishes
the manifest package to npm with provenance when a matching numeric tag reaches
GitHub, then creates a GitHub Release. First push the release commit through the
approved branch/mirror route and verify CI for that exact commit. Then push only
its release tag; watch the Publish run matched by repository, workflow, and commit
using the available `gh`/shell tools. Do not watch an unqualified "latest run".

The tag workflow currently also fires on a later mirror/tag push after a local
npm publication. Do not trigger it blindly: it would try to publish the same
immutable npm version again. Resolve the publication route before the tag push;
changing or disabling the workflow is separate work, not an automatic skill step.

## Changelog and release notes

- Accumulate entries under `## [Unreleased]`; released headings are
  `## [2026.10.25] - YYYY-MM-DD`.
- Follow the surrounding `### Added`, `### Changed`, and `### Fixed` sections.
  Group by user-visible behavior. Include measured numbers only with evidence.
- Credit external PRs with `#NNN (thanks @username)`.
- `scripts/extract-changelog.sh` includes Unreleased and numeric three-part
  versions sharing the first two components. For calendar versions this is a
  year/month rollup. It does not bound the patch component or collect suffixed
  versions; inspect its output rather than assuming generic prerelease support.

## Hook limits

The explicit skill installer resolves `git rev-parse --git-path hooks`, supports
linked worktrees and `core.hooksPath`, and copies the hook so removing a worktree
cannot leave a dangling link. Context gathering does not install hooks.

The separate `scripts/install-hooks.mjs` used by `pnpm install` still looks for
`.git/hooks`: it can overwrite a normal checkout's hook and skips linked
worktrees. Review existing hooks before the install; use the explicit installer
when linked-worktree support is needed.

`scripts/pre-push` checks `v*` tags against the working tree's package version and
changelog. Its GitHub CI check is limited: missing gh, an unavailable API, or zero
check runs do not block; it rejects pending checks and explicit failure, but does
not establish that every required check succeeded. Independently verify CI on the
release commit. This hook does not validate a direct npm publication.
