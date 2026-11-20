---
name: release
description: Commit all pending changes, push them to main, bump the version and push a version tag so GitHub Actions builds and publishes a new Relay release. Use only when asked to release, ship or cut a version.
argument-hint: "[patch|minor|major|x.y.z]"
disable-model-invocation: true
model: haiku
allowed-tools: Bash(git *), Bash(npm run typecheck), Bash(npm version *), Bash(node -p *)
---

# Release Relay

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the signed Windows
installer and publishes it with the updater's `latest.json`. Installed copies update from that
release, so a bad tag ships to every install. Stop and report at the first failing step. Never
force-push, never move or delete an existing tag.

The only version source is `package.json` (`src-tauri/tauri.conf.json` reads it, and
`Cargo.toml`'s version is unused). `npm version` keeps `package-lock.json` in step.

## 1. Check the starting point

- `git branch --show-current` must be `main`. If not, stop and say so; don't switch branches
  with uncommitted work.
- `git fetch origin main --tags`, then confirm `main` isn't behind `origin/main`. If it is, stop.

## 2. Commit pending changes (skip if `git status --porcelain` is empty)

- Run `npm run typecheck`. If it fails, stop and show the errors.
- Look at `git status` and `git diff`. Don't commit anything that looks like a secret or local
  config (`.env*`, `*.key`, `settings.local.json`, credentials). If you see one, stop and ask.
- `git add -A` and commit with a message in this repo's style: one plain sentence listing what
  changed, comma-separated, no prefix like `feat:`, no trailing period. Example:
  `Frosted menus and toasts with a sliding hover pill, no toasts for things you can see happen`.

## 3. Pick the version

- The last release is `git describe --tags --abbrev=0`; the changes are
  `git log <last-tag>..HEAD --oneline`.
- If `$ARGUMENTS` is `patch`, `minor`, `major` or an exact `x.y.z`, use it.
- Otherwise choose: **patch** if every commit since the last tag is a fix, **minor** if any
  adds or changes a feature. Never pick **major** on your own. Say which you chose and why in
  one line.
- If there are no commits since the last tag, stop: there's nothing to release.

## 4. Bump, tag and push

```bash
npm version <patch|minor|major|x.y.z> --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "Relay v$VERSION"
git push origin main
git push origin "v$VERSION"
```

Push `main` before the tag, so the tag never points at a commit the remote branch doesn't have.
If `git tag` fails because the tag exists, stop. If a push fails on the network, retry up to
three times; if it's rejected, stop and report it (don't force).

## 5. Report

Reply in three short lines: the version released, the commits it includes (from step 3), and
that the build is running at `https://github.com/dylannsw/relay/actions`. The release appears
on the Releases page when the workflow finishes (a few minutes on `windows-latest`).
