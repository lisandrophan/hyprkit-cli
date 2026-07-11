import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { versionsMatch } from "@/domains/versioning/checking/version-utils.js";
import { detectPluginState } from "./install-mode-detector.js";

export type ClaudePluginHealthStatus =
	| "missing"
	| "orphan-cache"
	| "disabled"
	| "installed-stale-version"
	| "installed-stale-source"
	| "installed-current";

export interface ClaudePluginHealthOptions {
	expectedVersion?: string | null;
	expectedSource?: string | null;
}

export interface ClaudePluginHealth {
	status: ClaudePluginHealthStatus;
	shouldRefresh: boolean;
	installedVersion: string | null;
	source: string | null;
}

export function detectClaudePluginHealth(
	claudeDir: string,
	options: ClaudePluginHealthOptions = {},
): ClaudePluginHealth {
	const state = detectPluginState(claudeDir);
	const source = readMarketplaceSource(claudeDir, state.marketplace ?? "claudekit");
	const base = { installedVersion: state.version, source };

	if (!state.installed) {
		return {
			...base,
			status: state.staleCache ? "orphan-cache" : "missing",
			shouldRefresh: true,
		};
	}
	if (!state.enabled) return { ...base, status: "disabled", shouldRefresh: true };
	if (
		options.expectedVersion &&
		(!state.version || !versionsMatch(state.version, options.expectedVersion))
	) {
		return { ...base, status: "installed-stale-version", shouldRefresh: true };
	}
	if (options.expectedSource && (!source || !pathsMatch(source, options.expectedSource))) {
		return { ...base, status: "installed-stale-source", shouldRefresh: true };
	}
	return { ...base, status: "installed-current", shouldRefresh: false };
}

function readMarketplaceSource(claudeDir: string, marketplace: string): string | null {
	try {
		const parsed = JSON.parse(
			readFileSync(join(claudeDir, "plugins", "known_marketplaces.json"), "utf-8"),
		);
		if (!isRecord(parsed)) return null;
		const entry = isRecord(parsed[marketplace])
			? parsed[marketplace]
			: isRecord(parsed.marketplaces) && isRecord(parsed.marketplaces[marketplace])
				? parsed.marketplaces[marketplace]
				: null;
		if (!entry) return null;
		if (typeof entry.installLocation === "string") return entry.installLocation;
		if (isRecord(entry.source) && typeof entry.source.path === "string") return entry.source.path;
		return null;
	} catch {
		return null;
	}
}

function pathsMatch(actual: string, expected: string): boolean {
	return canonicalPath(actual) === canonicalPath(expected);
}

function canonicalPath(pathValue: string): string {
	const absolute = resolve(pathValue);
	const resolved = existsSync(absolute) ? realpathSync(absolute) : absolute;
	const normalized = normalize(resolved);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
