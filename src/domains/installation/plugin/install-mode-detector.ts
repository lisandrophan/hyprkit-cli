import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PathResolver } from "@/shared/path-resolver.js";
import { compareVersions } from "compare-versions";
import { collectEngineerHistoricalFiles } from "./historical-metadata-files.js";
import { collectOrphanedPluginLegacyFileProofs } from "./orphaned-plugin-legacy-files.js";

/**
 * Install-mode detection for the ClaudeKit Engineer kit.
 *
 * The kit can be present on a machine in one of four mutually exclusive modes:
 *  - "fresh"  : neither a legacy copy nor a plugin install is present
 *  - "legacy" : the kit was copied into ~/.claude/skills (the pre-plugin model)
 *  - "plugin" : the kit is installed as a Claude Code plugin (~/.claude/plugins/cache)
 *  - "mixed"  : both a legacy copy AND a plugin install are present (mid-migration)
 *
 * This module is filesystem-only and side-effect free so it is fully unit
 * testable: every reader takes an explicit claudeDir so tests can sandbox state.
 */

export const CK_PLUGIN_NAME = "ck";
export const CK_MARKETPLACE_NAME = "claudekit";
/** Kit key the CLI writes under metadata.json `kits` for a legacy copy install. */
export const ENGINEER_KIT_KEY = "engineer";

export type InstallMode = "fresh" | "legacy" | "plugin" | "mixed";

export interface PluginState {
	/** Registered in settings.json enabledPlugins (authoritative; matches `claude plugin list`). */
	installed: boolean;
	/** settings.json enabledPlugins marks the plugin enabled. */
	enabled: boolean;
	/** Resolved plugin version (cache dir name / git SHA), or null if unknown. */
	version: string | null;
	/** Marketplace the plugin was installed from, or null. */
	marketplace: string | null;
	/** Cache payload on disk but NOT registered — an orphaned cache left by uninstall. */
	staleCache: boolean;
}

export interface LegacyState {
	/** A CK-owned legacy Engineer payload is still present. */
	installed: boolean;
	/** Version recorded in metadata.json, or null when cache proof is the only signal. */
	version: string | null;
}

export interface InstallModeReport {
	mode: InstallMode;
	claudeDir: string;
	plugin: PluginState;
	legacy: LegacyState;
}

function readJsonSafe(filePath: string): unknown | null {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect Claude Code plugin install state for the official `ck@claudekit` plugin.
 *
 * `installed` is authoritative from settings.json `enabledPlugins` (this is what
 * `claude plugin list` reflects). The plugin cache directory
 * `plugins/cache/claudekit/ck/<version>/` resolves the version, and when it
 * exists WITHOUT a registration it is reported as an orphaned `staleCache`
 * (uninstall removes the registration but leaves the cached payload on disk).
 * Plugins or caches named `ck` under other marketplaces are unrelated and are
 * deliberately ignored.
 */
export function detectPluginState(claudeDir: string): PluginState {
	const state: PluginState = {
		installed: false,
		enabled: false,
		version: null,
		marketplace: null,
		staleCache: false,
	};

	// Authoritative signal: the exact CK-owned settings registration.
	const settings = readJsonSafe(join(claudeDir, "settings.json"));
	if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
		const registration = `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`;
		if (Object.hasOwn(settings.enabledPlugins, registration)) {
			state.installed = true;
			state.marketplace = CK_MARKETPLACE_NAME;
			if (settings.enabledPlugins[registration] === true) state.enabled = true;
		}
	}

	// Only the CK-owned marketplace cache participates in ClaudeKit lifecycle state.
	const ckDir = join(claudeDir, "plugins", "cache", CK_MARKETPLACE_NAME, CK_PLUGIN_NAME);
	if (existsSync(ckDir) && isDir(ckDir)) {
		state.marketplace = CK_MARKETPLACE_NAME;
		const versions = safeReaddir(ckDir).filter((version) => isDir(join(ckDir, version)));
		if (versions.length > 0) {
			state.version = selectPluginCacheVersion(versions, ckDir);
		}
		if (!state.installed) state.staleCache = true;
	}

	return state;
}

function selectPluginCacheVersion(versions: string[], ckDir: string): string {
	const comparable = versions.filter(isComparableSemver);
	if (comparable.length > 0) {
		return comparable.sort((a, b) => compareVersions(normalizeVersion(b), normalizeVersion(a)))[0];
	}

	// Non-semver cache names are commonly git SHAs; newest by mtime remains the
	// best filesystem-only signal in that shape.
	return versions
		.map((v) => ({ v, mtime: statMtime(join(ckDir, v)) }))
		.sort((a, b) => b.mtime - a.mtime)[0].v;
}

function isComparableSemver(version: string): boolean {
	try {
		compareVersions(normalizeVersion(version), normalizeVersion(version));
		return true;
	} catch {
		return false;
	}
}

function normalizeVersion(version: string): string {
	return version.replace(/^v/, "");
}

/**
 * Detect a legacy (copied-into-~/.claude) install of the engineer kit.
 *
 * Metadata tracks normal copied installs. For files orphaned by pruned metadata,
 * exact same-path bytes in an official CK plugin cache are accepted as proof.
 */
export function detectLegacyState(claudeDir: string): LegacyState {
	const metadata = readJsonSafe(join(claudeDir, "metadata.json"));
	const hasLegacyPayload = hasPluginSuppliedLegacyFiles(claudeDir, metadata);
	if (!isRecord(metadata)) return { installed: hasLegacyPayload, version: null };

	// Multi-kit format: kits.engineer
	if (isRecord(metadata.kits) && isRecord(metadata.kits[ENGINEER_KIT_KEY])) {
		const kit = metadata.kits[ENGINEER_KIT_KEY] as Record<string, unknown>;
		return {
			installed: hasLegacyPayload,
			version: hasLegacyPayload && typeof kit.version === "string" ? kit.version : null,
		};
	}

	// Legacy single-kit format: root-level name/version with installed files
	const hasFiles =
		(Array.isArray((metadata as Record<string, unknown>).files) &&
			((metadata as Record<string, unknown>).files as unknown[]).length > 0) ||
		(Array.isArray((metadata as Record<string, unknown>).installedFiles) &&
			((metadata as Record<string, unknown>).installedFiles as unknown[]).length > 0);
	if (typeof metadata.version === "string" && hasFiles && hasLegacyPayload) {
		return { installed: true, version: metadata.version };
	}

	return { installed: hasLegacyPayload, version: null };
}

export function classifyInstallMode(plugin: PluginState, legacy: LegacyState): InstallMode {
	if (plugin.installed && legacy.installed) return "mixed";
	if (plugin.installed) return "plugin";
	if (legacy.installed) return "legacy";
	return "fresh";
}

/**
 * Full install-mode report. Defaults to the resolved global Claude config dir,
 * but accepts an explicit claudeDir for tests and multi-profile scenarios.
 */
export function detectInstallMode(
	claudeDir: string = PathResolver.getGlobalKitDir(),
): InstallModeReport {
	const plugin = detectPluginState(claudeDir);
	const legacy = detectLegacyState(claudeDir);
	return { mode: classifyInstallMode(plugin, legacy), claudeDir, plugin, legacy };
}

/**
 * Resolve the currently registered plugin cache root. Returns null for stale
 * cache payloads that are not registered/enabled in settings.json.
 */
export function resolveInstalledPluginCacheRoot(
	claudeDir: string = PathResolver.getGlobalKitDir(),
): string | null {
	const plugin = detectPluginState(claudeDir);
	if (!plugin.installed || !plugin.marketplace || !plugin.version) return null;

	const cacheRoot = join(
		claudeDir,
		"plugins",
		"cache",
		plugin.marketplace,
		CK_PLUGIN_NAME,
		plugin.version,
	);
	return existsSync(cacheRoot) && isDir(cacheRoot) ? cacheRoot : null;
}

/**
 * Resolve a source path inside the installed plugin cache. The extra nested
 * `.claude/` candidate keeps the resolver tolerant of Claude Code cache layout
 * changes while preferring today's plugin payload shape.
 */
export function resolveInstalledPluginCacheSubpath(
	relativePath: string,
	claudeDir: string = PathResolver.getGlobalKitDir(),
): string | null {
	const root = resolveInstalledPluginCacheRoot(claudeDir);
	if (!root) return null;

	const candidates = [join(root, relativePath), join(root, ".claude", relativePath)];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const PLUGIN_SUPPLIED_LEGACY_PREFIXES = ["agents/", "skills/"];

/**
 * True when the legacy flat-copy install still has CK-owned files that are now
 * supplied by the plugin. Metadata remains authoritative for tracked files;
 * otherwise exact same-path bytes in an official CK plugin cache prove an
 * orphaned legacy file. This avoids trusting arbitrary/custom files.
 */
export function hasTrackedPluginSuppliedLegacyFiles(
	claudeDir: string = PathResolver.getGlobalKitDir(),
): boolean {
	const metadata = readJsonSafe(join(claudeDir, "metadata.json"));
	return hasPluginSuppliedLegacyFiles(claudeDir, metadata);
}

function hasPluginSuppliedLegacyFiles(claudeDir: string, metadata: unknown): boolean {
	const historicalFiles = collectEngineerHistoricalFiles(metadata);

	for (const file of historicalFiles) {
		const resolvedPath = resolveSafePluginSuppliedLegacyPath(claudeDir, file.path);
		if (!resolvedPath || !existsSync(resolvedPath)) continue;
		if (file.ownership === "user" && !checksumMatches(resolvedPath, file.checksum)) continue;
		return true;
	}

	return (
		collectOrphanedPluginLegacyFileProofs(
			claudeDir,
			historicalFiles.map((file) => file.path),
		).length > 0
	);
}

function resolveSafePluginSuppliedLegacyPath(claudeDir: string, pathValue: string): string | null {
	const normalized = normalizeLegacyPath(pathValue).replace(/^\.\/+/, "");
	if (!isPluginSuppliedLegacyPath(normalized)) return null;
	const safe = resolveSafeChildPath(claudeDir, normalized);
	if (!safe) return null;

	const relativePath = normalizeLegacyPath(relative(resolve(claudeDir), safe));
	if (!isPluginSuppliedLegacyPath(relativePath)) return null;
	return safe;
}

function resolveSafeChildPath(baseDir: string, pathValue: string): string | null {
	const normalized = normalizeLegacyPath(pathValue);
	if (!normalized || hasPathTraversal(normalized) || isAbsoluteLike(normalized)) return null;

	const resolvedBase = resolve(baseDir);
	const resolvedTarget = resolve(resolvedBase, normalized);
	const relativePath = normalizeLegacyPath(relative(resolvedBase, resolvedTarget));
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return null;
	if (isAbsoluteLike(relativePath)) return null;
	return resolvedTarget;
}

function isPluginSuppliedLegacyPath(pathValue: string): boolean {
	const normalized = normalizeLegacyPath(pathValue).replace(/^\.claude\//, "");
	return PLUGIN_SUPPLIED_LEGACY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function checksumMatches(filePath: string, expected?: string): boolean {
	if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) return false;
	try {
		const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
		return actual.toLowerCase() === expected.toLowerCase();
	} catch {
		return false;
	}
}

function hasPathTraversal(pathValue: string): boolean {
	return pathValue.split("/").some((segment) => segment === "..");
}

function isAbsoluteLike(pathValue: string): boolean {
	return pathValue.startsWith("/") || pathValue.startsWith("//") || /^[A-Za-z]:/.test(pathValue);
}

function normalizeLegacyPath(pathValue: string): string {
	return pathValue.replace(/\\/g, "/");
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function statMtime(p: string): number {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}
