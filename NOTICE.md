# NOTICE

`hyprkit-cli` is a fork of **claudekit-cli** by Duy Nguyen.

- Upstream: https://github.com/mrgoonie/claudekit-cli
- Fork point: `07d8c24f084f1ce73907c508a71e77516abe0a9a` (upstream v4.5.2)
- Licence: MIT, unchanged. The upstream `LICENSE` file is kept verbatim and the
  original copyright notice stands.

The overwhelming majority of this code is upstream's work. This fork exists only
because the kit registry is a compile-time enum with no runtime override, so a
private kit cannot be installed without changing the source.

## What this fork changes

| Area | Change |
|------|--------|
| `package.json` | Published as `hyprkit-cli`; binary is `hk`, not `ck`; version restarted at 0.1.0 |
| `src/types/kit.ts` | Adds a `hyprkit` kit (`pcldev/hyprkit`) to `KitType`, `isValidKitType` and `AVAILABLE_KITS`. `engineer` and `marketing` are untouched and still work. |
| `src/types/kit.ts` | `ClaudeKitPackageMetadataSchema` accepts a `hyprkit` layout key alongside `claudekit` |
| `src/shared/kit-layout.ts` | Reads the `hyprkit` layout key, falling back to `claudekit` |
| `src/shared/path-resolver.ts` and 20 other files | CLI state directory `~/.claudekit` → `~/.hyprkit`, so this fork and an installed `claudekit-cli` do not share `projects.json`, `locks/` or caches |
| `src/shared/deletion-pattern-expander.ts` | Registers `hk` as the legacy command prefix for the hyprkit kit |
| npm package self-detection | The package-manager detectors look for `hyprkit-cli` rather than `claudekit-cli` |
| Help text | `--kit` now lists `hyprkit, engineer, marketing` |

Deliberately **not** changed: the ClaudeKit name in user-facing output, comments and
the config dashboard. Renaming ~900 strings across 269 files would turn every upstream
merge into a conflict, for no functional gain.

## Known divergence from the hyprkit kit

The CLI reads and writes `.ck.json` / `.ckignore` as the kit's config files. The
hyprkit kit uses `.hk.json` / `.hkignore`. Installation is unaffected — the lookup is
wrapped in try/catch and degrades to "no preferences" — but `hk config` and
`hk doctor` operate on `.ck.json`, which the kit's own hooks ignore. Do not use the
config dashboard against a hyprkit project until this is reconciled.
