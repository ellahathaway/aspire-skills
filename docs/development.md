# Development

Use Node.js 22 or later and Git. Run commands from the repository root.

## Making changes

Create branches from `dev` and target ordinary contributor PRs at `dev`. Main
accepts generated release and backport PRs.

`dev` must not contain `CHANGELOG.md` or generated `opencode/` catalogs.
Before opening a PR, run:

```bash
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.

## Backporting without a release

Comment `/backport to <branch>` on a PR.

[Backport PR to branch](../.github/workflows/backport.yml) checks the commenter's
write access, applies the PR patch, and opens
`backport/pr-<number>-to-<branch>`. Conflicts require a manual backport.

## Releasing

Dispatch [Release](../.github/workflows/release.yml) from `main`.

The workflow selects a dev snapshot, updates its canonical versions, generates
the changelog placeholder and OpenCode catalogs, and opens a draft
`release/<version>` PR into `main`. Changelog metadata identifies the previous
release. Later dev commits stay out unless you select a later snapshot.

The `aspire-skills-release` label triggers
[Release Changelog](../.github/workflows/release-changelog.md). Copilot writes
notes for the selected dev range and may change only the newest changelog entry.

Review the notes before merging. A pending placeholder blocks the release. If
generation fails, fix the error and reapply the label, or finalize the entry
manually without changing its release metadata.

Describe what changes for users of plugins, skills, canvases, hooks, and catalogs.
Leave out CI, build, and release infrastructure. The PR's source commit list is
review evidence, not a substitute for release notes. Hidden HTML comments record
the selected source range and whether notes are complete; they are not part of
the published release description.

Merge the release PR with a **merge commit**, preserving its version-update
commit. The workflow tags the merge commit and publishes a source-only GitHub
release with the reviewed notes.

After the merge, the backport workflow opens
`backport/pr-<number>-to-dev`. Review and merge that PR. The backport excludes
`CHANGELOG.md` and `opencode/` but carries the version changes, which bumps `dev`
to the new release version.

## Automatic main-to-dev backports

[Backport PR to branch](../.github/workflows/backport.yml) also runs after every PR
merged into `main`. It applies the PR's patch to `dev`, excludes `CHANGELOG.md`
and `opencode/`, and opens `backport/pr-<number>-to-dev`.

Review and merge each generated PR. A conflicting patch fails without commenting
on the source PR.
