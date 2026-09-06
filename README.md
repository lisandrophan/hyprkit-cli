# hyprkit-cli

Installs and updates [hyprkit](https://github.com/lisandrophan/hyprkit) — a personal
Claude Code kit — into a project or into `~/.claude`.

```bash
npm i -g hyprkit-cli
cd /path/to/project
hk init --kit hyprkit
```

## This is a fork

`hyprkit-cli` is [claudekit-cli](https://github.com/mrgoonie/claudekit-cli) by
Duy Nguyen, MIT licensed. Almost all of this code is his.

The fork exists for one reason: the kit registry is a compile-time enum with no
runtime override, so a private kit cannot be installed without changing the source.
It adds a `hyprkit` kit, renames the binary to `hk`, moves the CLI's state to
`~/.hyprkit` so it does not collide with an installed `claudekit-cli`, and fixes
four install-path bugs (below). Upstream's `engineer` and `marketing` kits still
work through it.

See [NOTICE.md](NOTICE.md) for the fork point and the full list of changes.

## Commands

```bash
hk init --kit hyprkit              # install or update in the current project
hk init --kit hyprkit -g           # install into ~/.claude, for every project
hk init --kit hyprkit --dry-run    # show what would change
hk uninstall --kit hyprkit         # remove, keeping files you edited
hk doctor                          # health check
hk config                          # config dashboard
```

`hk init` is both install and update — re-run it to take a new release.

### Useful flags

| Flag | Effect |
|------|--------|
| `-y, --yes` | Non-interactive: latest stable, current directory |
| `--force` | Reinstall even when already at the latest version |
| `--force-overwrite` | Take incoming versions of files you edited |
| `-r, --release <tag>` | Install a specific release |
| `--use-git` | Clone over SSH instead of the GitHub API (needs `--release`) |
| `--exclude <glob>` | Skip matching files (repeatable) |

## What it protects

Every installed file is recorded with a SHA-256 checksum and an ownership state.
On update:

- A file identical to the last install is **skipped** — a typical update touches
  ~20 files out of 1265 rather than rewriting all of them.
- A file **you edited** is kept, listed on stdout, and recorded as `ck-modified`
  against the checksum the kit shipped. That reference does not move, so the
  protection holds across every later update, not just the next one.
- `settings.json` is **merged**, not replaced: your hooks and permissions survive
  alongside the kit's.
- `.env` and other secret-bearing files are never written over.

`--force-overwrite` opts out and takes the incoming versions.

## Bugs fixed relative to upstream

All four were found by installing the kit and checking the result, not by reading
the code. They affect any kit, not just this one.

**Manifest lookups never matched.** Release manifests key kit files with the
`.claude/` prefix stripped, but both lookups passed the prefixed path. Every lookup
missed, so ownership resolved to `user` for the whole install and the merger
re-copied files it should have compared. A real claudekit install records all 1512
of its files as `user` for this reason.

**Updates overwrote files the user had edited.** `OwnershipChecker` is never called
on the install path — only at uninstall — so an edited kit file was replaced with no
warning and no backup.

**`Accept: application/octet-stream` on source archives.** Correct for the
release-asset endpoint, rejected with 415 by `/tarball/` and `/zipball/`. Both are
`api.github.com` URLs, so the header cannot be picked by host alone. Only shows on a
release with no uploaded asset, where the CLI falls back to GitHub's automatic
tarball — which is why upstream never hit it.

**Unfiltered tarball extraction.** The allowlist that trims a release to `.claude/`,
`plans/` and a few root files was applied to the git-clone path only. Installing from
an automatic tarball copied the kit repository's own `scripts/`, `docs/`, `guide/`,
`package.json` and `README.md` into the target project.

**Legacy kit detection defaulted to `engineer`.** A kit ships `metadata.json` with
its name at the top level, and the matcher only knew `engineer` and `marketing`, so
installing any other kit invented a phantom `engineer` entry beside the real one.

## Development

```bash
bun install
bun run typecheck && bun run lint && bun test
bun run build
```

Testing an install without touching your real `~/.claude`:

```bash
export CK_TEST_HOME=/tmp/hk-test
hk init --kit hyprkit --dir /tmp/some-project -y
```

`CK_TEST_HOME` redirects both `~/.claude` and `~/.hyprkit`.

### Staying close to upstream

The diff against upstream is deliberately small so merges stay cheap — the
ClaudeKit name is left throughout the source and the config dashboard on purpose,
because renaming ~900 strings across 269 files would turn every merge into a
conflict.

```bash
git fetch upstream && git merge upstream/main
bun install && bun run typecheck && bun test && bun run build
```

A conflict outside the files listed in NOTICE.md means the fork has drifted; fix
the drift rather than resolving the conflict.

## Licence

MIT, unchanged from upstream. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
