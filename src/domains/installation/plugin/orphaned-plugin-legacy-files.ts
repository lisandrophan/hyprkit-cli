import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const LEGACY_ROOTS = ["agents", "skills"] as const;
const CK_PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;

export interface OrphanedPluginLegacyFileProof {
	relativePath: string;
	cachePath: string;
}

/**
 * Find untracked flat files whose bytes are proven by an official ClaudeKit
 * plugin cache version at the same agents/ or skills/ path.
 */
export function collectOrphanedPluginLegacyFileProofs(
	claudeDir: string,
	excludedRelativePaths: Iterable<string> = [],
): OrphanedPluginLegacyFileProof[] {
	const cacheRoot = join(claudeDir, "plugins", "cache", "claudekit", "ck");
	if (!isSafeDirectoryWithin(claudeDir, cacheRoot)) return [];

	const excluded = new Set(
		[...excludedRelativePaths].map(normalizeRelativePath).filter(isPluginLegacyPath),
	);
	const proofs = new Map<string, OrphanedPluginLegacyFileProof>();
	const versions = safeReadDir(cacheRoot)
		.filter((entry) => entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const version of versions) {
		const versionRoot = join(cacheRoot, version.name);
		if (!isSafeDirectoryWithin(cacheRoot, versionRoot)) continue;
		if (!hasExpectedCkPluginManifest(cacheRoot, versionRoot, version.name)) continue;
		for (const payloadRoot of [versionRoot, join(versionRoot, ".claude")]) {
			for (const legacyRoot of LEGACY_ROOTS) {
				const sourceRoot = join(payloadRoot, legacyRoot);
				if (!isSafeDirectoryWithin(cacheRoot, sourceRoot)) continue;
				collectPayloadProofs(claudeDir, cacheRoot, payloadRoot, sourceRoot, excluded, proofs);
			}
		}
	}

	return [...proofs.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Revalidate a cache ownership proof immediately before destructive cleanup. */
export function orphanedPluginLegacyFileProofMatches(
	claudeDir: string,
	proof: OrphanedPluginLegacyFileProof,
): boolean {
	const cacheRoot = join(claudeDir, "plugins", "cache", "claudekit", "ck");
	const relativePath = normalizeRelativePath(proof.relativePath);
	const versionRoot = resolveCacheVersionRootForLegacyPath(
		cacheRoot,
		proof.cachePath,
		relativePath,
	);
	if (!versionRoot) return false;
	const versionName = normalizeRelativePath(relative(resolve(cacheRoot), resolve(versionRoot)));
	if (!hasExpectedCkPluginManifest(cacheRoot, versionRoot, versionName)) return false;
	return legacyPayloadBytesMatch(claudeDir, cacheRoot, proof.cachePath, relativePath);
}

function collectPayloadProofs(
	claudeDir: string,
	cacheRoot: string,
	payloadRoot: string,
	directory: string,
	excluded: Set<string>,
	proofs: Map<string, OrphanedPluginLegacyFileProof>,
): void {
	for (const entry of safeReadDir(directory).sort((a, b) => a.name.localeCompare(b.name))) {
		const sourcePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (isSafeDirectoryWithin(cacheRoot, sourcePath)) {
				collectPayloadProofs(claudeDir, cacheRoot, payloadRoot, sourcePath, excluded, proofs);
			}
			continue;
		}
		if (!entry.isFile() || !isSafeRegularFileWithin(cacheRoot, sourcePath)) continue;

		const relativePath = normalizeRelativePath(relative(payloadRoot, sourcePath));
		if (excluded.has(relativePath) || proofs.has(relativePath)) continue;
		const proof = { relativePath, cachePath: sourcePath };
		if (legacyPayloadBytesMatch(claudeDir, cacheRoot, sourcePath, relativePath)) {
			proofs.set(relativePath, proof);
		}
	}
}

function resolveCacheVersionRootForLegacyPath(
	cacheRoot: string,
	cachePath: string,
	relativePath: string,
): string | null {
	const cacheRelative = normalizeRelativePath(relative(resolve(cacheRoot), resolve(cachePath)));
	const suffix = `/${relativePath}`;
	if (!cacheRelative.endsWith(suffix)) return null;
	const prefix = cacheRelative.slice(0, -suffix.length).split("/");
	if (prefix.length !== 1 && !(prefix.length === 2 && prefix[1] === ".claude")) return null;
	const versionName = prefix[0];
	if (!versionName || versionName === ".." || versionName.includes("/")) return null;
	return join(cacheRoot, versionName);
}

function hasExpectedCkPluginManifest(
	cacheRoot: string,
	versionRoot: string,
	versionName: string,
): boolean {
	if (!isSafeDirectoryWithin(cacheRoot, versionRoot)) return false;
	const manifestPath = join(versionRoot, ...CK_PLUGIN_MANIFEST_PATH);
	if (!isSafeRegularFileWithin(cacheRoot, manifestPath)) return false;

	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
		if (!isRecord(manifest) || manifest.name !== "ck" || typeof manifest.version !== "string") {
			return false;
		}
		const expectedVersion = normalizePluginVersion(versionName);
		const manifestVersion = normalizePluginVersion(manifest.version);
		return Boolean(expectedVersion && manifestVersion && expectedVersion === manifestVersion);
	} catch {
		return false;
	}
}

function legacyPayloadBytesMatch(
	claudeDir: string,
	cacheRoot: string,
	cachePath: string,
	relativePath: string,
): boolean {
	const targetPath = resolveSafeLegacyPath(claudeDir, relativePath);
	if (
		!targetPath ||
		!isSafeRegularFileWithin(cacheRoot, cachePath) ||
		!isSafeRegularFileWithin(claudeDir, targetPath)
	) {
		return false;
	}

	try {
		if (statSync(cachePath).size !== statSync(targetPath).size) return false;
		return readFileSync(cachePath).equals(readFileSync(targetPath));
	} catch {
		return false;
	}
}

function normalizePluginVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSafeLegacyPath(claudeDir: string, pathValue: string): string | null {
	const normalized = normalizeRelativePath(pathValue);
	if (!isPluginLegacyPath(normalized) || hasPathTraversal(normalized)) return null;
	const resolvedBase = resolve(claudeDir);
	const resolvedTarget = resolve(resolvedBase, normalized);
	const targetRelative = normalizeRelativePath(relative(resolvedBase, resolvedTarget));
	return targetRelative === normalized ? resolvedTarget : null;
}

function isPluginLegacyPath(pathValue: string): boolean {
	return LEGACY_ROOTS.some((root) => pathValue.startsWith(`${root}/`));
}

function normalizeRelativePath(pathValue: string): string {
	return pathValue
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/^\.claude\//, "");
}

function hasPathTraversal(pathValue: string): boolean {
	return pathValue.split("/").some((segment) => segment === "..");
}

function safeReadDir(directory: string): Dirent[] {
	try {
		return readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

function isSafeDirectoryWithin(baseDir: string, directoryPath: string): boolean {
	if (!isPathWithin(baseDir, directoryPath) || pathHasSymlinkComponent(baseDir, directoryPath)) {
		return false;
	}
	try {
		return lstatSync(directoryPath).isDirectory() && realPathIsWithin(baseDir, directoryPath);
	} catch {
		return false;
	}
}

function isSafeRegularFileWithin(baseDir: string, filePath: string): boolean {
	if (!isPathWithin(baseDir, filePath) || pathHasSymlinkComponent(baseDir, filePath)) return false;
	try {
		return lstatSync(filePath).isFile() && realPathIsWithin(baseDir, filePath);
	} catch {
		return false;
	}
}

function isPathWithin(baseDir: string, targetPath: string): boolean {
	const relativePath = normalizeRelativePath(relative(resolve(baseDir), resolve(targetPath)));
	return Boolean(relativePath && relativePath !== ".." && !relativePath.startsWith("../"));
}

function realPathIsWithin(baseDir: string, targetPath: string): boolean {
	const relativePath = normalizeRelativePath(
		relative(realpathSync(baseDir), realpathSync(targetPath)),
	);
	return Boolean(relativePath && relativePath !== ".." && !relativePath.startsWith("../"));
}

function pathHasSymlinkComponent(baseDir: string, targetPath: string): boolean {
	const relativePath = normalizeRelativePath(relative(resolve(baseDir), resolve(targetPath)));
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return true;
	let current = resolve(baseDir);
	for (const segment of relativePath.split("/")) {
		current = join(current, segment);
		try {
			if (lstatSync(current).isSymbolicLink()) return true;
		} catch {
			return true;
		}
	}
	return false;
}
