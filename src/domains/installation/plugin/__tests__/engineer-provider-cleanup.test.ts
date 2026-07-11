import { describe, expect, test } from "bun:test";
import type { CodexPluginState } from "../codex-plugin-installer.js";
import { cleanupEngineerProviderPlugins } from "../engineer-provider-cleanup.js";

function codexState(status: CodexPluginState["status"]): CodexPluginState {
	const installed = status.startsWith("installed") || status === "disabled";
	return {
		status,
		pluginId: "ck@claudekit",
		enabled: status === "installed-current",
		installed,
		installedVersion: installed ? "1.0.0" : null,
		expectedVersion: null,
		marketplace: installed ? "claudekit" : null,
		expectedMarketplace: null,
		source: null,
		expectedSource: null,
		shouldRefresh: installed,
	};
}

const claudeAbsent = {
	uninstalled: false,
	staleCacheRemoved: false,
	pluginStillInstalled: false,
};

describe("cleanupEngineerProviderPlugins", () => {
	test("fails before provider calls when a test omits isolation dependencies", async () => {
		const previousTestHome = process.env.CK_TEST_HOME;
		process.env.CK_TEST_HOME = "/tmp/ck-provider-cleanup-test";
		let claudeCalled = false;
		try {
			await expect(
				cleanupEngineerProviderPlugins({
					uninstallClaudePlugin: async () => {
						claudeCalled = true;
						return claudeAbsent;
					},
				}),
			).rejects.toThrow("must inject Claude and Codex cleanup and verification dependencies");
			expect(claudeCalled).toBe(false);
		} finally {
			if (previousTestHome === undefined) Reflect.deleteProperty(process.env, "CK_TEST_HOME");
			else process.env.CK_TEST_HOME = previousTestHome;
		}
	});

	test("attempts and verifies both providers", async () => {
		const calls: string[] = [];
		const result = await cleanupEngineerProviderPlugins({
			uninstallClaudePlugin: async () => {
				calls.push("claude-cleanup");
				return { ...claudeAbsent, uninstalled: true };
			},
			removeCodexPlugin: async () => {
				calls.push("codex-cleanup");
				return { removed: true, marketplaceRemoved: true, pluginStillInstalled: false };
			},
			verifyClaudePluginAbsent: () => {
				calls.push("claude-verify");
				return true;
			},
			readCodexPluginState: async () => {
				calls.push("codex-verify");
				return codexState("missing");
			},
		});

		expect(result.success).toBe(true);
		expect(result.changed).toBe(true);
		expect(calls).toContainAllValues([
			"claude-cleanup",
			"codex-cleanup",
			"claude-verify",
			"codex-verify",
		]);
	});

	test("counts Claude marketplace-only cleanup as a provider change", async () => {
		const result = await cleanupEngineerProviderPlugins({
			uninstallClaudePlugin: async () => ({
				...claudeAbsent,
				marketplaceRemoved: true,
				marketplaceStillRegistered: false,
			}),
			removeCodexPlugin: async () => ({
				removed: false,
				marketplaceRemoved: false,
				pluginStillInstalled: false,
			}),
			verifyClaudePluginAbsent: () => true,
			readCodexPluginState: async () => codexState("missing"),
		});

		expect(result).toMatchObject({ success: true, changed: true, errors: [] });
	});

	test("is idempotent when both providers are already absent", async () => {
		const deps = {
			uninstallClaudePlugin: async () => claudeAbsent,
			removeCodexPlugin: async () => ({
				removed: false,
				marketplaceRemoved: false,
				pluginStillInstalled: false,
			}),
			verifyClaudePluginAbsent: () => true,
			readCodexPluginState: async () => codexState("missing"),
		};

		const first = await cleanupEngineerProviderPlugins(deps);
		const second = await cleanupEngineerProviderPlugins(deps);
		expect(first).toMatchObject({ success: true, changed: false, errors: [] });
		expect(second).toMatchObject({ success: true, changed: false, errors: [] });
	});

	test("attempts Codex cleanup after Claude cleanup throws", async () => {
		let codexAttempted = false;
		const result = await cleanupEngineerProviderPlugins({
			uninstallClaudePlugin: async () => {
				throw new Error("claude failed");
			},
			removeCodexPlugin: async () => {
				codexAttempted = true;
				return { removed: true, marketplaceRemoved: true, pluginStillInstalled: false };
			},
			verifyClaudePluginAbsent: () => true,
			readCodexPluginState: async () => codexState("missing"),
		});

		expect(codexAttempted).toBe(true);
		expect(result.success).toBe(false);
		expect(result.errors.join(" ")).toContain("Claude plugin cleanup failed");
	});

	test("reports residual and unknown provider states as failures", async () => {
		const result = await cleanupEngineerProviderPlugins({
			uninstallClaudePlugin: async () => ({
				...claudeAbsent,
				pluginStillInstalled: true,
				error: "plugin remains registered",
			}),
			removeCodexPlugin: async () => ({
				removed: false,
				marketplaceRemoved: false,
				pluginStillInstalled: false,
			}),
			verifyClaudePluginAbsent: () => false,
			readCodexPluginState: async () => ({
				...codexState("unknown"),
				error: "plugin list failed",
			}),
		});

		expect(result.success).toBe(false);
		expect(result.errors.join(" ")).toContain("plugin remains registered");
		expect(result.errors.join(" ")).toContain("could not verify absence (unknown");
	});

	test("fails when unavailable provider surfaces cannot verify persisted absence", async () => {
		for (const status of ["codex-unavailable", "plugins-unsupported"] as const) {
			const result = await cleanupEngineerProviderPlugins({
				uninstallClaudePlugin: async () => claudeAbsent,
				removeCodexPlugin: async () => ({ removed: false, marketplaceRemoved: false }),
				verifyClaudePluginAbsent: () => true,
				readCodexPluginState: async () => codexState(status),
			});
			expect(result.success).toBe(false);
			expect(result.errors.join(" ")).toContain(`could not verify absence (${status}`);
		}
	});
});
