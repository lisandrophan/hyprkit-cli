/**
 * Kit config filenames.
 *
 * The hyprkit kit stores its config as `.hk.json` and its scout ignore list as
 * `.hkignore`. The engineer and marketing kits still use the `.ck.json` /
 * `.ckignore` names this CLI was written against.
 *
 * Rule: **read both, write the current name.** Anything that discovers, watches,
 * copies or protects config files must consider both names; anything that creates
 * one writes `.hk.json`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Config filename this CLI writes. */
export const KIT_CONFIG_FILE = ".hk.json";
/** Config filename used by the engineer and marketing kits. */
export const LEGACY_KIT_CONFIG_FILE = ".ck.json";
/** Both config filenames, current name first. */
export const KIT_CONFIG_FILES = [KIT_CONFIG_FILE, LEGACY_KIT_CONFIG_FILE] as const;

/** Scout ignore filename this CLI writes. */
export const KIT_IGNORE_FILE = ".hkignore";
/** Scout ignore filename used by the engineer and marketing kits. */
export const LEGACY_KIT_IGNORE_FILE = ".ckignore";
/** Both ignore filenames, current name first. */
export const KIT_IGNORE_FILES = [KIT_IGNORE_FILE, LEGACY_KIT_IGNORE_FILE] as const;

/** True when the name is either kit config filename. */
export function isKitConfigFile(name: string): boolean {
	return (KIT_CONFIG_FILES as readonly string[]).includes(name);
}

/** True when the name is either kit ignore filename. */
export function isKitIgnoreFile(name: string): boolean {
	return (KIT_IGNORE_FILES as readonly string[]).includes(name);
}

/**
 * Path of the config file that exists in `dir`, preferring the current name.
 *
 * @returns The existing path, or null when neither name is present.
 */
export function findKitConfigPath(dir: string): string | null {
	for (const name of KIT_CONFIG_FILES) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Path to read config from in `dir`: the existing file, else the current name.
 *
 * Use for reads that tolerate a missing file. Use {@link findKitConfigPath} when
 * "neither exists" needs to be distinguishable.
 */
export function resolveKitConfigPath(dir: string): string {
	return findKitConfigPath(dir) ?? join(dir, KIT_CONFIG_FILE);
}

/** Both candidate config paths in `dir`, current name first. */
export function kitConfigPaths(dir: string): string[] {
	return KIT_CONFIG_FILES.map((name) => join(dir, name));
}
