import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	CK_MARKETPLACE_NAME,
	CK_PLUGIN_NAME,
	detectPluginState,
} from "@/domains/installation/plugin/install-mode-detector.js";
import { PluginInstaller } from "@/domains/installation/plugin/plugin-installer.js";
import { PathResolver } from "@/shared/path-resolver.js";
import { inspectClaudeMarketplaceRegistration } from "./claude-plugin-health.js";

export interface UninstallPluginResult {
	uninstalled: boolean;
	staleCacheRemoved: boolean;
	marketplaceRemoved?: boolean;
	pluginStillInstalled: boolean;
	marketplaceStillRegistered?: boolean;
	error?: string;
}

export interface UninstallPluginOptions {
	claudeDir?: string;
	installer?: PluginInstaller;
}

/**
 * Remove the Engineer `ck` plugin, its CK-owned marketplace registration, and
 * any leftover cache payload. Marketplace state is handled independently from
 * plugin/cache state so interrupted installs converge on repeated cleanup.
 */
export async function uninstallEnginePlugin(
	opts: UninstallPluginOptions = {},
): Promise<UninstallPluginResult> {
	const claudeDir = opts.claudeDir ?? PathResolver.getGlobalKitDir();
	const installer = opts.installer ?? new PluginInstaller(undefined, claudeDir);
	const state = detectPluginState(claudeDir);

	let uninstalled = false;
	let marketplaceRemoved = false;
	const errors: string[] = [];
	if (state.installed) {
		const removed = await installer.uninstall();
		if (removed.ok) {
			uninstalled = true;
		} else {
			errors.push(`plugin uninstall failed: ${removed.stderr.trim() || "unknown error"}`);
		}
	}

	const marketplaceBefore = inspectClaudeMarketplaceRegistration(claudeDir, CK_MARKETPLACE_NAME);
	let marketplaceRemovalError: string | null = null;
	if (marketplaceBefore.status !== "absent") {
		const removed = await installer.marketplaceRemove(CK_MARKETPLACE_NAME);
		marketplaceRemoved = removed.ok;
		if (!removed.ok) {
			marketplaceRemovalError = removed.stderr.trim() || "unknown error";
		}
	}

	// Purge cache payload (covers both a registered uninstall and an orphaned stale cache).
	let staleCacheRemoved = false;
	const cacheDir = join(claudeDir, "plugins", "cache", CK_MARKETPLACE_NAME, CK_PLUGIN_NAME);
	if (existsSync(cacheDir)) {
		rmSync(cacheDir, { recursive: true, force: true });
		staleCacheRemoved = true;
	}

	const pluginStillInstalled = detectPluginState(claudeDir).installed;
	if (pluginStillInstalled) {
		errors.push("plugin remains registered after cleanup");
	}

	const marketplaceAfter = inspectClaudeMarketplaceRegistration(claudeDir, CK_MARKETPLACE_NAME);
	const marketplaceStillRegistered = marketplaceAfter.status !== "absent";
	if (marketplaceRemovalError && !isAlreadyAbsentError(marketplaceRemovalError)) {
		errors.push(`marketplace remove failed: ${marketplaceRemovalError}`);
	}
	if (marketplaceAfter.status === "present") {
		errors.push("marketplace remains registered after cleanup");
	} else if (marketplaceAfter.status === "unverifiable") {
		errors.push("marketplace absence cannot be verified after cleanup");
	}

	return {
		uninstalled,
		staleCacheRemoved,
		marketplaceRemoved,
		pluginStillInstalled,
		marketplaceStillRegistered,
		error: errors.length > 0 ? errors.join("; ") : undefined,
	};
}

function isAlreadyAbsentError(message: string): boolean {
	return /(?:not found|does not exist|is not installed|already (?:absent|removed))/i.test(message);
}
