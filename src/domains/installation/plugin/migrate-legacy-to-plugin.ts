import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { detectClaudePluginHealth } from "@/domains/installation/plugin/claude-plugin-health.js";
import {
	type HistoricalTrackedFile,
	collectEngineerHistoricalFiles,
} from "@/domains/installation/plugin/historical-metadata-files.js";
import {
	ENGINEER_KIT_KEY,
	type InstallMode,
	detectInstallMode,
	detectPluginState,
} from "@/domains/installation/plugin/install-mode-detector.js";
import { PluginInstaller } from "@/domains/installation/plugin/plugin-installer.js";
import { PathResolver } from "@/shared/path-resolver.js";

/**
 * Legacy -> plugin migration for the ClaudeKit Engineer kit.
 *
 * NOTE: this is an INTERNAL flow invoked by `ck init` / `ck update`. It is NOT a
 * new `ck migrate` command (that name already belongs to the portable/provider
 * reconciler). Ordering is rollback-safe: the destructive legacy cleanup runs
 * ONLY after the plugin install has verified, so a failed install leaves the
 * legacy copy untouched.
 */

export type MigrateAction =
	| "noop-already-plugin"
	| "skipped-cc-unsupported"
	| "install-failed"
	| "installed-fresh"
	| "migrated-from-legacy";

export interface MigrateResult {
	action: MigrateAction;
	/** Install mode observed BEFORE migration. */
	modeBefore: InstallMode;
	pluginVerified: boolean;
	backupDir: string | null;
	removedPaths: string[];
	receiptPath: string | null;
	error?: string;
}

/** Removes legacy ck-owned files; returns removed relative paths. Injectable for tests. */
export type LegacyRemover = (
	claudeDir: string,
	backupDir: string,
	pluginSourceDir?: string,
) => string[];

export interface MigrateOptions {
	/** Staged kit dir containing .claude-plugin/marketplace.json (the local marketplace source). */
	pluginSourceDir: string;
	claudeDir?: string;
	installer?: PluginInstaller;
	removeLegacy?: LegacyRemover;
	/** ISO timestamp; injected in tests, runtime passes new Date().toISOString(). */
	now?: string;
	/** Failure injection for the final receipt write. */
	writeReceiptFn?: typeof writeReceipt;
}

export async function migrateLegacyToPlugin(opts: MigrateOptions): Promise<MigrateResult> {
	const claudeDir = opts.claudeDir ?? PathResolver.getGlobalKitDir();
	const installer = opts.installer ?? new PluginInstaller(undefined, claudeDir);
	const removeLegacy = opts.removeLegacy ?? defaultLegacyRemover;
	const ts = opts.now ?? new Date().toISOString();

	const before = detectInstallMode(claudeDir);
	let forceMarketplaceReplacement = false;

	// Plugin-only installs still need repair when disabled, stale, or registered
	// against a previous staged source. Only a fully current install is a no-op.
	if (before.mode === "plugin") {
		const health = detectClaudePluginHealth(claudeDir, {
			expectedVersion: readExpectedPluginVersion(opts.pluginSourceDir),
			expectedSource: opts.pluginSourceDir,
		});
		if (!health.shouldRefresh) {
			prunePluginSuppliedLegacyFilesFromMetadata(claudeDir);
			return base("noop-already-plugin", before.mode, true);
		}
		forceMarketplaceReplacement = health.status === "installed-stale-source";
	}

	// Older Claude Code without plugin support: return a precise result so explicit
	// plugin mode can fail without removing the working copied skills.
	if (!(await installer.isClaudeAvailable()) || !(await installer.isPluginSupported())) {
		return base("skipped-cc-unsupported", before.mode, false);
	}

	// Non-destructive: register/refresh marketplace + install/update + verify. Surface
	// command failures early before removing the legacy copy.
	const prepared = before.plugin.installed
		? await refreshExistingPlugin(
				installer,
				opts.pluginSourceDir,
				before.plugin.enabled,
				claudeDir,
				forceMarketplaceReplacement,
			)
		: await installPlugin(installer, opts.pluginSourceDir, claudeDir);
	if (!prepared.ok) {
		return {
			...base("install-failed", before.mode, false),
			error: prepared.error,
		};
	}
	const verified = await installer.verifyInstalled();
	if (!verified) {
		const rollbackFailures = prepared.rollback?.() ?? [];
		return {
			...base("install-failed", before.mode, false),
			error: appendRollbackFailures("plugin did not verify after install", rollbackFailures),
		};
	}

	// Destructive file cleanup, metadata pruning, and receipt writing are one local
	// transaction. Any late filesystem error restores copied files, metadata, the
	// previous receipt, and the prior Claude registration.
	let backupDir: string | null = null;
	let removedPaths: string[] = [];
	const metadataPath = join(claudeDir, "metadata.json");
	const receiptFile = join(claudeDir, ".ck-migration-log.json");
	const metadataSnapshot = snapshotFile(metadataPath);
	const receiptSnapshot = snapshotFile(receiptFile);
	let receiptPath: string;
	try {
		if (before.legacy.installed) {
			backupDir = join(claudeDir, "backups", `ck-legacy-${ts.replace(/[:.]/g, "-")}`);
			createSafeBackupDirectory(claudeDir, backupDir);
			removedPaths = removeLegacy(claudeDir, backupDir, opts.pluginSourceDir);
			prunePluginSuppliedLegacyFilesFromMetadata(claudeDir, removedPaths);
		}

		// Record the version that is now installed (post-install), not the pre-install one.
		const installedVersion = detectPluginState(claudeDir).version;
		receiptPath = (opts.writeReceiptFn ?? writeReceipt)(claudeDir, {
			fromMode: before.mode,
			toMode: "plugin",
			pluginVersion: installedVersion,
			backupDir,
			removedPaths,
			timestamp: ts,
		});
	} catch (error) {
		const rollbackFailures =
			backupDir && removedPaths.length > 0
				? restoreLegacyBackup(claudeDir, backupDir, removedPaths)
				: [];
		const metadataFailure = restoreFileSafely(
			claudeDir,
			metadataPath,
			metadataSnapshot,
			"metadata.json",
		);
		if (metadataFailure) rollbackFailures.push(metadataFailure);
		const receiptFailure = restoreFileSafely(
			claudeDir,
			receiptFile,
			receiptSnapshot,
			".ck-migration-log.json",
		);
		if (receiptFailure) rollbackFailures.push(receiptFailure);
		rollbackFailures.push(...(prepared.rollback?.() ?? []));
		const rollbackDetail =
			rollbackFailures.length > 0
				? `; rollback incomplete: ${rollbackFailures.join(", ")}${backupDir ? `; backup retained at ${backupDir}` : ""}`
				: "";
		return {
			...base("install-failed", before.mode, false),
			...(rollbackFailures.length > 0 ? { backupDir, removedPaths } : {}),
			error: `plugin migration transaction failed: ${(error as Error).message}${rollbackDetail}`,
		};
	}

	return {
		action: before.legacy.installed ? "migrated-from-legacy" : "installed-fresh",
		modeBefore: before.mode,
		pluginVerified: true,
		backupDir,
		removedPaths,
		receiptPath,
	};
}

function readExpectedPluginVersion(pluginSourceDir: string): string | null {
	const manifest = readJsonSafe(join(pluginSourceDir, ".claude", ".claude-plugin", "plugin.json"));
	return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null;
}

function base(
	action: MigrateAction,
	modeBefore: InstallMode,
	pluginVerified: boolean,
): MigrateResult {
	return {
		action,
		modeBefore,
		pluginVerified,
		backupDir: null,
		removedPaths: [],
		receiptPath: null,
	};
}

const PLUGIN_SUPPLIED_LEGACY_PREFIXES = ["agents/", "skills/"];
const LEGACY_SENTINEL_FILENAMES = new Set([".gitignore"]);

/**
 * Default legacy remover: backs up and removes ck-owned engineer kit files that
 * are now supplied by the Claude Code plugin, preserving user-owned files and
 * legacy runtime surfaces that the plugin format does not yet provide.
 */
export function defaultLegacyRemover(
	claudeDir: string,
	backupDir: string,
	pluginSourceDir?: string,
): string[] {
	const meta = readJsonSafe(join(claudeDir, "metadata.json"));
	const files = collectEngineerHistoricalFiles(meta);
	const removed: string[] = [];
	for (const file of files) {
		const legacyPath = resolveSafePluginSuppliedLegacyPath(claudeDir, file.path);
		if (!legacyPath) continue;
		if (!existsSync(legacyPath.absolutePath)) continue;
		if (
			!isSafeToRemovePluginSuppliedLegacyFile(
				file,
				claudeDir,
				legacyPath.absolutePath,
				legacyPath.relativePath,
				pluginSourceDir,
			)
		)
			continue;
		// Back up before removing.
		if (!backupAndRemove(claudeDir, backupDir, legacyPath.relativePath, legacyPath.absolutePath))
			continue;
		removed.push(legacyPath.relativePath);
	}
	removed.push(...removeOrphanLegacySentinels(claudeDir, backupDir, removed));
	return removed;
}

function backupAndRemove(
	sourceBaseDir: string,
	backupDir: string,
	relativePath: string,
	abs: string,
): boolean {
	const backupTarget = resolveSafeChildPath(backupDir, relativePath);
	if (
		!backupTarget ||
		!isSafeDirectoryWithin(sourceBaseDir, backupDir) ||
		!isSafeRegularFileWithin(sourceBaseDir, abs)
	)
		return false;
	try {
		if (pathHasSymlinkComponent(backupDir, dirname(backupTarget))) return false;
		mkdirSync(dirname(backupTarget), { recursive: true });
		if (pathHasSymlinkComponent(backupDir, backupTarget)) return false;
		copyFileSync(abs, backupTarget);
		rmSync(abs, { force: true });
		return true;
	} catch {
		return false;
	}
}

function restoreLegacyBackup(
	claudeDir: string,
	backupDir: string,
	removedPaths: string[],
): string[] {
	const failures: string[] = [];
	if (!isSafeDirectoryWithin(claudeDir, backupDir)) {
		return removedPaths.map((pathValue) => `${pathValue}: unsafe backup directory`);
	}

	for (const pathValue of removedPaths) {
		const source = resolveSafeChildPath(backupDir, pathValue);
		const target = resolveSafeChildPath(claudeDir, pathValue);
		if (!source || !target || !isSafeRegularFileWithin(backupDir, source)) {
			failures.push(`${pathValue}: unsafe or missing backup file`);
			continue;
		}
		if (pathHasSymlinkComponent(claudeDir, target) || existsSync(target)) {
			failures.push(`${pathValue}: unsafe rollback destination`);
			continue;
		}

		try {
			const targetParent = dirname(target);
			if (pathHasSymlinkComponent(claudeDir, targetParent)) {
				failures.push(`${pathValue}: unsafe rollback destination`);
				continue;
			}
			mkdirSync(targetParent, { recursive: true });
			if (
				!isSafeDirectoryWithin(claudeDir, targetParent) ||
				pathHasSymlinkComponent(claudeDir, target)
			) {
				failures.push(`${pathValue}: unsafe rollback destination`);
				continue;
			}
			copyFileSync(source, target);
			if (!isSafeRegularFileWithin(claudeDir, target)) {
				failures.push(`${pathValue}: restored file failed safety verification`);
			}
		} catch (error) {
			failures.push(`${pathValue}: ${(error as Error).message}`);
		}
	}
	return failures;
}

function removeOrphanLegacySentinels(
	claudeDir: string,
	backupDir: string,
	removedTrackedPaths: string[],
): string[] {
	const normalizedRemoved = removedTrackedPaths.map(normalizeLegacyPath);
	const rootsToSweep = new Set<string>();
	for (const pathValue of normalizedRemoved) {
		const [root] = pathValue.split("/");
		if (root && PLUGIN_SUPPLIED_LEGACY_PREFIXES.includes(`${root}/`)) {
			rootsToSweep.add(root);
		}
	}

	const removed: string[] = [];
	for (const root of [...rootsToSweep].sort(compareLegacyPaths)) {
		const rootAbs = join(claudeDir, root);
		if (!existsSync(rootAbs)) continue;
		const sentinels = findLegacySentinels(rootAbs).sort((a, b) =>
			compareLegacyPaths(relative(claudeDir, a), relative(claudeDir, b)),
		);
		for (const sentinelAbs of sentinels) {
			const sentinelPath = normalizeLegacyPath(relative(claudeDir, sentinelAbs));
			if (!isSafeToRemoveLegacySentinel(claudeDir, sentinelPath, sentinelAbs, normalizedRemoved))
				continue;
			if (!backupAndRemove(claudeDir, backupDir, sentinelPath, sentinelAbs)) continue;
			removed.push(sentinelPath);
		}
	}
	return removed;
}

function findLegacySentinels(dir: string): string[] {
	const out: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries.sort((a, b) => compareLegacyPaths(a.name, b.name))) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findLegacySentinels(abs));
		} else if (entry.isFile() && LEGACY_SENTINEL_FILENAMES.has(entry.name)) {
			out.push(abs);
		}
	}
	return out;
}

function isSafeToRemoveLegacySentinel(
	claudeDir: string,
	sentinelPath: string,
	sentinelAbs: string,
	removedTrackedPaths: string[],
): boolean {
	if (!isPluginSuppliedLegacyPath(sentinelPath)) return false;
	if (!LEGACY_SENTINEL_FILENAMES.has(sentinelPath.split("/").pop() ?? "")) return false;
	if (!isSafeRegularFileWithin(claudeDir, sentinelAbs)) return false;

	const sentinelDir = dirname(sentinelPath).replace(/\\/g, "/");
	if (!removedTrackedPaths.some((removedPath) => removedPath.startsWith(`${sentinelDir}/`))) {
		return false;
	}

	return directoryContainsOnlySentinels(dirname(sentinelAbs));
}

function directoryContainsOnlySentinels(dir: string): boolean {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}

	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!directoryContainsOnlySentinels(abs)) return false;
		} else if (!entry.isFile() || !LEGACY_SENTINEL_FILENAMES.has(entry.name)) {
			return false;
		}
	}
	return true;
}

function isSafeToRemovePluginSuppliedLegacyFile(
	file: HistoricalTrackedFile,
	claudeDir: string,
	abs: string,
	relativePath: string,
	pluginSourceDir?: string,
): boolean {
	if (!isSafeRegularFileWithin(claudeDir, abs)) return false;
	if (file.ownership === "ck") return true;
	if (file.ownership === "unknown") {
		return stagedPluginPayloadMatches(pluginSourceDir, relativePath, abs);
	}
	if (file.ownership !== "user") return false;

	// Offline/local kit installs can lack release-manifest.json, so files are
	// tracked as user-owned even though the installer just copied them. Remove
	// only when the tracked checksum still matches disk; edited or untracked
	// user files stay protected.
	return checksumMatches(abs, file.checksum);
}

function stagedPluginPayloadMatches(
	pluginSourceDir: string | undefined,
	relativePath: string,
	legacyPath: string,
): boolean {
	if (!pluginSourceDir) return false;
	const stagedPath = resolveSafePluginSuppliedLegacyPath(
		join(pluginSourceDir, ".claude"),
		relativePath,
	);
	if (!stagedPath || !existsSync(stagedPath.absolutePath)) return false;

	try {
		if (!isSafeRegularFileWithin(join(pluginSourceDir, ".claude"), stagedPath.absolutePath))
			return false;
		return readFileSync(legacyPath).equals(readFileSync(stagedPath.absolutePath));
	} catch {
		return false;
	}
}

function isSafeRegularFileWithin(baseDir: string, filePath: string): boolean {
	const resolvedBase = resolve(baseDir);
	const resolvedFile = resolve(filePath);
	const relativePath = normalizeLegacyPath(relative(resolvedBase, resolvedFile));
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return false;
	if (pathHasSymlinkComponent(resolvedBase, resolvedFile)) return false;

	try {
		if (!lstatSync(resolvedFile).isFile()) return false;
		const realBase = realpathSync(resolvedBase);
		const realFile = realpathSync(resolvedFile);
		const realRelative = normalizeLegacyPath(relative(realBase, realFile));
		return Boolean(realRelative && realRelative !== ".." && !realRelative.startsWith("../"));
	} catch {
		return false;
	}
}

function createSafeBackupDirectory(claudeDir: string, backupDir: string): void {
	if (pathHasSymlinkComponent(claudeDir, backupDir)) {
		throw new Error("unsafe backup directory: symlink or path escape detected");
	}
	mkdirSync(backupDir, { recursive: true });
	if (!isSafeDirectoryWithin(claudeDir, backupDir)) {
		throw new Error("unsafe backup directory: path is outside Claude config");
	}
}

function isSafeDirectoryWithin(baseDir: string, directoryPath: string): boolean {
	const resolvedBase = resolve(baseDir);
	const resolvedDirectory = resolve(directoryPath);
	const relativePath = normalizeLegacyPath(relative(resolvedBase, resolvedDirectory));
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return false;
	if (pathHasSymlinkComponent(resolvedBase, resolvedDirectory)) return false;

	try {
		if (!lstatSync(resolvedDirectory).isDirectory()) return false;
		const realBase = realpathSync(resolvedBase);
		const realDirectory = realpathSync(resolvedDirectory);
		const realRelative = normalizeLegacyPath(relative(realBase, realDirectory));
		return Boolean(realRelative && realRelative !== ".." && !realRelative.startsWith("../"));
	} catch {
		return false;
	}
}

function isSafeDirectoryAtOrWithin(baseDir: string, directoryPath: string): boolean {
	const resolvedBase = resolve(baseDir);
	const resolvedDirectory = resolve(directoryPath);
	if (resolvedBase === resolvedDirectory) {
		try {
			return realpathSync(resolvedBase) === realpathSync(resolvedDirectory);
		} catch {
			return false;
		}
	}
	return isSafeDirectoryWithin(resolvedBase, resolvedDirectory);
}

function pathHasSymlinkComponent(baseDir: string, targetPath: string): boolean {
	const resolvedBase = resolve(baseDir);
	const relativePath = normalizeLegacyPath(relative(resolvedBase, resolve(targetPath)));
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return true;

	let current = resolvedBase;
	for (const segment of relativePath.split("/")) {
		current = join(current, segment);
		try {
			if (lstatSync(current).isSymbolicLink()) return true;
		} catch (error) {
			// A not-yet-created destination component is safe; source callers apply
			// an existence/realpath check immediately after this walk.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return true;
		}
	}
	return false;
}

function checksumMatches(filePath: string, expected?: string): boolean {
	if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
		return false;
	}
	try {
		const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
		return actual.toLowerCase() === expected.toLowerCase();
	} catch {
		return false;
	}
}

function isPluginSuppliedLegacyPath(pathValue: string): boolean {
	const normalized = normalizeLegacyPath(pathValue).replace(/^\.claude\//, "");
	return PLUGIN_SUPPLIED_LEGACY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function resolveSafePluginSuppliedLegacyPath(
	claudeDir: string,
	pathValue: string,
): { absolutePath: string; relativePath: string } | null {
	const normalized = normalizeLegacyPath(pathValue).replace(/^\.\/+/, "");
	if (!isPluginSuppliedLegacyPath(normalized)) return null;
	const safe = resolveSafeChildPath(claudeDir, normalized);
	if (!safe) return null;

	const relativePath = normalizeLegacyPath(relative(resolve(claudeDir), safe));
	if (!isPluginSuppliedLegacyPath(relativePath)) return null;
	return { absolutePath: safe, relativePath };
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

function hasPathTraversal(pathValue: string): boolean {
	return pathValue.split("/").some((segment) => segment === "..");
}

function isAbsoluteLike(pathValue: string): boolean {
	return pathValue.startsWith("/") || pathValue.startsWith("//") || /^[A-Za-z]:/.test(pathValue);
}

function normalizeLegacyPath(pathValue: string): string {
	return pathValue.replace(/\\/g, "/");
}

function compareLegacyPaths(a: string, b: string): number {
	const normalizedA = normalizeLegacyPath(a);
	const normalizedB = normalizeLegacyPath(b);
	if (normalizedA < normalizedB) return -1;
	if (normalizedA > normalizedB) return 1;
	return 0;
}

function prunePluginSuppliedLegacyFilesFromMetadata(
	claudeDir: string,
	removedPaths?: string[],
): void {
	const metadataPath = join(claudeDir, "metadata.json");
	const meta = readJsonSafe(metadataPath);
	if (!isRecord(meta)) return;

	const removed = removedPaths
		? new Set(removedPaths.map(normalizeComparableLegacyPath).filter(Boolean))
		: null;
	let changed = false;

	const pruneFiles = (files: unknown): unknown => {
		if (!Array.isArray(files)) return files;
		const pruned = files.filter((file) => {
			if (typeof file === "string") {
				const normalizedPath = normalizeComparableLegacyPath(file);
				const resolvedPath = resolveSafePluginSuppliedLegacyPath(claudeDir, normalizedPath);
				const shouldPrune =
					(removed?.has(normalizedPath) ?? false) ||
					(resolvedPath !== null && !existsSync(resolvedPath.absolutePath));
				return !shouldPrune;
			}
			if (!isRecord(file) || typeof file.path !== "string") return true;
			const normalizedPath = normalizeComparableLegacyPath(file.path);
			const resolvedPath = resolveSafePluginSuppliedLegacyPath(claudeDir, normalizedPath);
			const shouldPrune =
				(removed?.has(normalizedPath) ?? false) ||
				(resolvedPath !== null && !existsSync(resolvedPath.absolutePath));
			return !shouldPrune;
		});
		if (pruned.length !== files.length) changed = true;
		return pruned;
	};

	let pruneTransitionalRoot = true;
	if (isRecord(meta.kits)) {
		const engineer = (meta.kits as Record<string, unknown>)[ENGINEER_KIT_KEY];
		if (isRecord(engineer)) {
			engineer.files = pruneFiles(engineer.files);
			engineer.installedFiles = pruneFiles(engineer.installedFiles);
		}
		pruneTransitionalRoot = isRecord(engineer) && Object.keys(meta.kits).length === 1;
	}
	if (pruneTransitionalRoot) {
		meta.files = pruneFiles(meta.files);
		meta.installedFiles = pruneFiles(meta.installedFiles);
	}

	if (changed) {
		writeFileSync(metadataPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
	}
}

function normalizeComparableLegacyPath(pathValue: string): string {
	return normalizeLegacyPath(pathValue)
		.replace(/^\.\/+/, "")
		.replace(/^\.claude\//, "");
}

function writeReceipt(
	claudeDir: string,
	receipt: {
		fromMode: InstallMode;
		toMode: "plugin";
		pluginVersion: string | null;
		backupDir: string | null;
		removedPaths: string[];
		timestamp: string;
	},
): string {
	const receiptPath = join(claudeDir, ".ck-migration-log.json");
	const existing = readJsonSafe(receiptPath);
	const history = Array.isArray(existing) ? existing : [];
	history.push(receipt);
	writeFileSync(receiptPath, `${JSON.stringify(history, null, 2)}\n`, "utf-8");
	return receiptPath;
}

function readJsonSafe(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function snapshotFile(filePath: string): Buffer | null {
	return existsSync(filePath) ? readFileSync(filePath) : null;
}

function restoreFileSafely(
	rootDir: string,
	filePath: string,
	content: Buffer | null,
	label: string,
): string | null {
	const resolvedRoot = resolve(rootDir);
	const resolvedFile = resolve(filePath);
	const relativePath = normalizeLegacyPath(relative(resolvedRoot, resolvedFile));
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
		return `${label}: restore target escapes owned root`;
	}
	if (pathHasSymlinkComponent(resolvedRoot, resolvedFile)) {
		return `${label}: unsafe restore target`;
	}

	try {
		if (content === null) {
			if (!existsSync(resolvedFile)) return null;
			if (!isSafeRegularFileWithin(resolvedRoot, resolvedFile)) {
				return `${label}: unsafe restore target`;
			}
			rmSync(resolvedFile, { force: true });
			return null;
		}

		const parent = dirname(resolvedFile);
		if (parent !== resolvedRoot && pathHasSymlinkComponent(resolvedRoot, parent)) {
			return `${label}: unsafe restore parent`;
		}
		mkdirSync(parent, { recursive: true });
		if (
			!isSafeDirectoryAtOrWithin(resolvedRoot, parent) ||
			pathHasSymlinkComponent(resolvedRoot, resolvedFile)
		) {
			return `${label}: unsafe restore target`;
		}
		if (existsSync(resolvedFile) && !isSafeRegularFileWithin(resolvedRoot, resolvedFile)) {
			return `${label}: unsafe restore target`;
		}
		writeFileSync(resolvedFile, content);
		return isSafeRegularFileWithin(resolvedRoot, resolvedFile)
			? null
			: `${label}: restored snapshot failed safety verification`;
	} catch (error) {
		return `${label}: ${(error as Error).message}`;
	}
}

interface PluginPrepareResult {
	ok: boolean;
	error?: string;
	rollback?: () => string[];
}

async function installPlugin(
	installer: PluginInstaller,
	pluginSourceDir: string,
	claudeDir: string,
): Promise<PluginPrepareResult> {
	const marketplace = await prepareClaudeMarketplace(installer, pluginSourceDir, claudeDir);
	if (!marketplace.ok) return marketplace;
	const installed = await installer.install("user");
	if (!installed.ok) {
		const rollbackFailures = marketplace.rollback?.() ?? [];
		return {
			ok: false,
			error: appendRollbackFailures(
				`plugin install failed: ${installed.stderr.trim()}`,
				rollbackFailures,
			),
		};
	}
	return { ok: true, rollback: marketplace.rollback };
}

async function refreshExistingPlugin(
	installer: PluginInstaller,
	pluginSourceDir: string,
	enabled: boolean,
	claudeDir: string,
	forceMarketplaceReplacement = false,
): Promise<PluginPrepareResult> {
	const marketplace = await prepareClaudeMarketplace(
		installer,
		pluginSourceDir,
		claudeDir,
		forceMarketplaceReplacement,
	);
	if (!marketplace.ok) return marketplace;

	if (!enabled) {
		const enabledResult = await installer.enable();
		if (!enabledResult.ok) {
			const rollbackFailures = marketplace.rollback?.() ?? [];
			return {
				ok: false,
				error: appendRollbackFailures(
					`plugin enable failed: ${enabledResult.stderr.trim()}`,
					rollbackFailures,
				),
			};
		}
	}

	const updated = await installer.update();
	if (!updated.ok) {
		const rollbackFailures = marketplace.rollback?.() ?? [];
		return {
			ok: false,
			error: appendRollbackFailures(
				`plugin update failed: ${updated.stderr.trim()}`,
				rollbackFailures,
			),
		};
	}
	return { ok: true, rollback: marketplace.rollback };
}

interface ClaudeRegistrationSnapshot {
	claudeDir: string;
	files: Array<{ path: string; content: Buffer | null }>;
}

async function prepareClaudeMarketplace(
	installer: PluginInstaller,
	pluginSourceDir: string,
	claudeDir: string,
	forceReplacement = false,
): Promise<PluginPrepareResult> {
	const snapshot = snapshotClaudeRegistration(claudeDir);
	const rollback = () => restoreClaudeRegistration(snapshot);
	if (forceReplacement) {
		const removed = await installer.marketplaceRemove();
		if (!removed.ok) {
			const rollbackFailures = rollback();
			return {
				ok: false,
				error: appendRollbackFailures(
					`marketplace replacement failed: ${removed.stderr.trim()}`,
					rollbackFailures,
				),
			};
		}
		const replaced = await installer.marketplaceAdd(pluginSourceDir);
		if (replaced.ok) return { ok: true, rollback };
		const rollbackFailures = rollback();
		return {
			ok: false,
			error: describeRegistrationRollback(
				`marketplace replacement failed: ${replaced.stderr.trim()}`,
				rollbackFailures,
			),
		};
	}
	const added = await installer.marketplaceAdd(pluginSourceDir);
	if (added.ok) return { ok: true, rollback };

	const updated = await installer.marketplaceUpdate();
	if (updated.ok) return { ok: true, rollback };

	const removed = await installer.marketplaceRemove();
	if (!removed.ok) {
		const rollbackFailures = rollback();
		return {
			ok: false,
			error: appendRollbackFailures(
				`marketplace replacement failed: ${removed.stderr.trim() || updated.stderr.trim() || added.stderr.trim()}`,
				rollbackFailures,
			),
		};
	}
	const replaced = await installer.marketplaceAdd(pluginSourceDir);
	if (replaced.ok) return { ok: true, rollback };

	const rollbackFailures = rollback();
	return {
		ok: false,
		error: describeRegistrationRollback(
			`marketplace replacement failed: ${replaced.stderr.trim() || updated.stderr.trim() || added.stderr.trim()}`,
			rollbackFailures,
		),
	};
}

function snapshotClaudeRegistration(claudeDir: string): ClaudeRegistrationSnapshot {
	return {
		claudeDir,
		files: [
			join(claudeDir, "plugins", "known_marketplaces.json"),
			join(claudeDir, "settings.json"),
		].map((path) => ({
			path,
			content: existsSync(path) ? readFileSync(path) : null,
		})),
	};
}

function restoreClaudeRegistration(snapshot: ClaudeRegistrationSnapshot): string[] {
	const failures: string[] = [];
	for (const file of snapshot.files) {
		const failure = restoreFileSafely(
			snapshot.claudeDir,
			file.path,
			file.content,
			normalizeLegacyPath(relative(snapshot.claudeDir, file.path)),
		);
		if (failure) failures.push(failure);
	}
	return failures;
}

function appendRollbackFailures(message: string, failures: string[]): string {
	return failures.length > 0 ? `${message}; rollback incomplete: ${failures.join(", ")}` : message;
}

function describeRegistrationRollback(message: string, failures: string[]): string {
	return failures.length > 0
		? appendRollbackFailures(message, failures)
		: `${message}; restored previous registration`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
