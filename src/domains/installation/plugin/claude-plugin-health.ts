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

export type ClaudeMarketplaceRegistrationStatus = "present" | "absent" | "unverifiable";

export interface ClaudeMarketplaceRegistration {
	status: ClaudeMarketplaceRegistrationStatus;
	source: string | null;
}

export function detectClaudePluginHealth(
	claudeDir: string,
	options: ClaudePluginHealthOptions = {},
): ClaudePluginHealth {
	const state = detectPluginState(claudeDir);
	const source = inspectClaudeMarketplaceRegistration(
		claudeDir,
		state.marketplace ?? "claudekit",
	).source;
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

/**
 * Inspect Claude's persisted marketplace registry without invoking the provider.
 * Both registry layouts observed in released Claude versions are supported.
 * Invalid bytes or an invalid nested container are explicitly unverifiable so
 * cleanup cannot report success from an unreadable registry.
 */
export function inspectClaudeMarketplaceRegistration(
	claudeDir: string,
	marketplace = "claudekit",
): ClaudeMarketplaceRegistration {
	const registryPath = join(claudeDir, "plugins", "known_marketplaces.json");
	if (!existsSync(registryPath)) return { status: "absent", source: null };

	try {
		const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf-8"));
		if (!isRecord(parsed)) return { status: "unverifiable", source: null };

		let rawEntry: unknown;
		if (Object.hasOwn(parsed, marketplace)) {
			rawEntry = parsed[marketplace];
		} else if (Object.hasOwn(parsed, "marketplaces")) {
			if (!isRecord(parsed.marketplaces)) {
				return { status: "unverifiable", source: null };
			}
			if (!Object.hasOwn(parsed.marketplaces, marketplace)) {
				return { status: "absent", source: null };
			}
			rawEntry = parsed.marketplaces[marketplace];
		} else {
			return { status: "absent", source: null };
		}

		if (!isRecord(rawEntry)) return { status: "present", source: null };
		if (typeof rawEntry.installLocation === "string") {
			return { status: "present", source: rawEntry.installLocation };
		}
		if (isRecord(rawEntry.source) && typeof rawEntry.source.path === "string") {
			return { status: "present", source: rawEntry.source.path };
		}
		return { status: "present", source: null };
	} catch {
		return { status: "unverifiable", source: null };
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
