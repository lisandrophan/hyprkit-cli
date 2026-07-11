import { PathResolver } from "@/shared/path-resolver.js";
import { inspectClaudeMarketplaceRegistration } from "./claude-plugin-health.js";
import {
	type CodexPluginState,
	detectCodexPluginState,
	removeCodexPlugin,
} from "./codex-plugin-installer.js";
import { detectPluginState } from "./install-mode-detector.js";
import { type UninstallPluginResult, uninstallEnginePlugin } from "./uninstall-plugin.js";

export interface EngineerProviderCleanupResult {
	success: boolean;
	changed: boolean;
	claude: UninstallPluginResult | null;
	codex: Awaited<ReturnType<typeof removeCodexPlugin>> | null;
	errors: string[];
}

export interface EngineerProviderCleanupDependencies {
	uninstallClaudePlugin?: () => Promise<UninstallPluginResult>;
	removeCodexPlugin?: () => Promise<Awaited<ReturnType<typeof removeCodexPlugin>>>;
	verifyClaudePluginAbsent?: () => boolean;
	readCodexPluginState?: () => Promise<CodexPluginState>;
}

function codexAbsenceIsVerifiable(state: CodexPluginState): boolean {
	return state.status === "missing";
}

/**
 * Remove the Engineer plugin from both supported providers.
 *
 * Each provider is attempted independently so one failure cannot strand the
 * other provider. Only ClaudeKit's fixed plugin and marketplace identifiers
 * are touched by the provider-specific cleanup functions.
 */
export async function cleanupEngineerProviderPlugins(
	deps: EngineerProviderCleanupDependencies = {},
): Promise<EngineerProviderCleanupResult> {
	if (
		process.env.CK_TEST_HOME &&
		(!deps.uninstallClaudePlugin ||
			!deps.removeCodexPlugin ||
			!deps.verifyClaudePluginAbsent ||
			!deps.readCodexPluginState)
	) {
		throw new Error(
			"Provider cleanup tests must inject Claude and Codex cleanup and verification dependencies",
		);
	}

	const uninstallClaude = deps.uninstallClaudePlugin ?? (() => uninstallEnginePlugin());
	const uninstallCodex = deps.removeCodexPlugin ?? (() => removeCodexPlugin());
	const verifyClaudeAbsent =
		deps.verifyClaudePluginAbsent ??
		(() => {
			const state = detectPluginState(PathResolver.getGlobalKitDir());
			const marketplace = inspectClaudeMarketplaceRegistration(PathResolver.getGlobalKitDir());
			return !state.installed && !state.staleCache && marketplace.status === "absent";
		});
	const readCodexState = deps.readCodexPluginState ?? (() => detectCodexPluginState());

	const [claudeAttempt, codexAttempt] = await Promise.allSettled([
		uninstallClaude(),
		uninstallCodex(),
	]);
	const errors: string[] = [];
	const claude = claudeAttempt.status === "fulfilled" ? claudeAttempt.value : null;
	const codex = codexAttempt.status === "fulfilled" ? codexAttempt.value : null;

	if (claudeAttempt.status === "rejected") {
		errors.push(`Claude plugin cleanup failed: ${String(claudeAttempt.reason)}`);
	} else if (
		claudeAttempt.value.error ||
		claudeAttempt.value.pluginStillInstalled ||
		claudeAttempt.value.marketplaceStillRegistered
	) {
		errors.push(
			`Claude plugin cleanup failed: ${
				claudeAttempt.value.error ??
				(claudeAttempt.value.pluginStillInstalled
					? "plugin is still installed"
					: "marketplace is still registered")
			}`,
		);
	}

	if (codexAttempt.status === "rejected") {
		errors.push(`Codex plugin cleanup failed: ${String(codexAttempt.reason)}`);
	} else if (codexAttempt.value.error || codexAttempt.value.pluginStillInstalled) {
		errors.push(
			`Codex plugin cleanup failed: ${codexAttempt.value.error ?? "plugin is still installed"}`,
		);
	}

	if (claudeAttempt.status === "fulfilled") {
		try {
			if (!verifyClaudeAbsent()) errors.push("Claude plugin cleanup could not verify absence");
		} catch (error) {
			errors.push(`Claude plugin cleanup verification failed: ${String(error)}`);
		}
	}

	if (codexAttempt.status === "fulfilled") {
		try {
			const state = await readCodexState();
			if (!codexAbsenceIsVerifiable(state)) {
				errors.push(
					`Codex plugin cleanup could not verify absence (${state.status}${state.error ? `: ${state.error}` : ""})`,
				);
			}
		} catch (error) {
			errors.push(`Codex plugin cleanup verification failed: ${String(error)}`);
		}
	}

	return {
		success: errors.length === 0,
		changed: Boolean(
			claude?.uninstalled ||
				claude?.staleCacheRemoved ||
				claude?.marketplaceRemoved ||
				codex?.removed ||
				codex?.marketplaceRemoved,
		),
		claude,
		codex,
		errors,
	};
}
