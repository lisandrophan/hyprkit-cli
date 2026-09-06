# What this fork changes

`hyprkit-cli` forks **claudekit-cli** by Duy Nguyen.

- Upstream: https://github.com/mrgoonie/claudekit-cli
- Fork point: `07d8c24f084f1ce73907c508a71e77516abe0a9a` (upstream v4.5.2)
- Licence: MIT, unchanged — `LICENSE` carries the original copyright notice.

This file exists to keep upstream merges cheap: it is the list of files the fork
touches, so a merge conflict anywhere else means the fork has drifted.

## Files touched

| Area | Change |
|------|--------|
| `package.json` | Published as `hyprkit-cli`; binary is `hk`, not `ck`; version restarted at 0.1.0 |
| `src/types/kit.ts` | Adds a `hyprkit` kit (`lisandrophan/hyprkit`) to `KitType`, `isValidKitType` and `AVAILABLE_KITS`. `engineer` and `marketing` are untouched and still work. |
| `src/types/kit.ts` | `ClaudeKitPackageMetadataSchema` accepts a `hyprkit` layout key alongside `claudekit` |
| `src/shared/kit-layout.ts` | Reads the `hyprkit` layout key, falling back to `claudekit` |
| `src/shared/path-resolver.ts` and 20 other files | CLI state directory `~/.claudekit` → `~/.hyprkit`, so this fork and an installed `claudekit-cli` do not share `projects.json`, `locks/` or caches |
| `src/shared/deletion-pattern-expander.ts` | Registers `hk` as the legacy command prefix for the hyprkit kit |
| npm package self-detection | The package-manager detectors look for `hyprkit-cli` rather than `claudekit-cli` |
| Help text | `--kit` now lists `hyprkit, engineer, marketing` |

Deliberately **not** changed: the ClaudeKit name in user-facing output, comments and
the config dashboard. Renaming ~900 strings across 269 files would turn every upstream
merge into a conflict, for no functional gain.

## Kit config filenames

The hyprkit kit stores its config as `.hk.json` and its scout ignore list as
`.hkignore`; the engineer and marketing kits use `.ck.json` / `.ckignore`. This fork
handles both through `src/shared/kit-config-files.ts`:

- **Reads** accept either name, preferring `.hk.json`.
- **Writes** follow whichever file already exists, and create `.hk.json` when neither
  does — so an engineer-kit project keeps a single config file rather than ending up
  with its settings split across two.
- Watchers, never-copy lists, legacy-repair markers and portable-config discovery
  consider both names.

## Behaviour changes

**Manifest lookups are normalised.** Release manifests key kit files without the
`.claude/` prefix, but `buildFileTrackingList` and `SelectiveMerger.shouldCopyFile`
passed the prefixed path. Every lookup missed, so ownership resolved to `user` for
the entire install and the merger re-copied files it should have compared. A real
claudekit install shows the same symptom: 1512 of 1512 files recorded as `user`.
`toManifestKey()` now normalises at both call sites.

**Locally modified kit files are held back on update.** Upstream records a
per-file checksum and an `ownership` field but only consults them at uninstall, so
an update silently replaced a kit file the user had edited, with no backup. This
fork compares the file against the checksum recorded by the previous install; a
mismatch means the user edited it, so the copy is skipped, the file is listed on
stdout, and it is recorded as `ck-modified` against the **shipped** checksum —
keeping that as the reference, or the edited content would become the new baseline
and the next update would overwrite it. `--force-overwrite` takes the incoming
version. `settings.json` is exempt (it has its own selective merge) and so is
`metadata.json` (CLI-managed state, rewritten every run).

**Source archives use the right Accept header.** `application/octet-stream` suits
the release-asset endpoint but `/tarball/` and `/zipball/` reject it with 415.
Both are `api.github.com` URLs, so the header was being chosen by host alone. Only
reachable on a release with no uploaded asset, where the CLI falls back to GitHub's
automatic tarball.

**Automatic tarballs are filtered.** The release allowlist (`.claude/`, `plans/`,
`CLAUDE.md`, `AGENTS.md`, `.gitignore`, `.repomixignore`, `.mcp.json`, `.opencode`,
`release-manifest.json`) was applied to the git-clone path only. Extracting an
automatic tarball copied the kit repository's own `scripts/`, `docs/`, `guide/`,
`package.json` and `README.md` into the target project. A pre-built release asset
is already trimmed by the kit's release job, so this path is left alone.

