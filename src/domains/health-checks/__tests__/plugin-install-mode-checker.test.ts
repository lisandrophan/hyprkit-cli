import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginInstallModeChecker } from "@/domains/health-checks/plugin-install-mode-checker.js";
import type { CodexPluginState } from "@/domains/installation/plugin/codex-plugin-installer.js";

const codexUnavailable: CodexPluginState = {
	status: "codex-unavailable",
	pluginId: "ck@claudekit",
	enabled: false,
	installed: false,
	installedVersion: null,
	expectedVersion: null,
	marketplace: null,
	expectedMarketplace: "claudekit",
	source: null,
	expectedSource: null,
	shouldRefresh: false,
};

describe("PluginInstallModeChecker", () => {
	let claudeDir: string;

	beforeEach(async () => {
		claudeDir = join(tmpdir(), `ck-doctor-${Date.now()}-${Math.round(performance.now())}`);
		await mkdir(claudeDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(claudeDir, { recursive: true, force: true });
	});

	const writeSettings = (enabledPlugins: Record<string, boolean>) =>
		writeFile(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins }), "utf-8");
	const writeMetadata = (obj: unknown) =>
		writeFile(join(claudeDir, "metadata.json"), JSON.stringify(obj), "utf-8");
	const writePluginCacheFile = async (version: string, relativePath: string, content: string) => {
		const versionRoot = join(claudeDir, "plugins", "cache", "claudekit", "ck", version);
		const manifestPath = join(versionRoot, ".claude-plugin", "plugin.json");
		const cacheFile = join(versionRoot, relativePath);
		await mkdir(dirname(manifestPath), { recursive: true });
		await writeFile(manifestPath, JSON.stringify({ name: "ck", version }), "utf-8");
		await mkdir(dirname(cacheFile), { recursive: true });
		await writeFile(cacheFile, content, "utf-8");
	};

	async function single(codexState: CodexPluginState = codexUnavailable) {
		const results = await new PluginInstallModeChecker(claudeDir, {
			detectCodexPluginState: async () => codexState,
		}).run();
		expect(results).toHaveLength(1);
		return results[0];
	}

	test("fresh -> info", async () => {
		const r = await single();
		expect(r.status).toBe("info");
		expect(r.message).toContain("fresh");
		expect(r.group).toBe("claudekit");
		expect(r.autoFixable).toBe(false);
	});

	test("legacy -> pass with version", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "# cook\n", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const r = await single();
		expect(r.status).toBe("pass");
		expect(r.message).toContain("legacy");
		expect(r.message).toContain("2.19.0");
	});

	test("reports persisted install mode preference", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					installModePreference: "legacy",
				},
			},
		});
		const r = await single();
		expect(r.message).toContain("preference: legacy (normal skills)");
	});

	test("persisted plugin consent with enabled plugin -> pass", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					installModePreference: "plugin",
				},
			},
		});
		await writeSettings({ "ck@claudekit": true });
		const r = await single();
		expect(r.status).toBe("pass");
		expect(r.message.toLowerCase()).toContain("plugin");
		expect(r.message).toContain("enabled");
	});

	test("warns when plugin mode has metadata-free legacy files proven by historical cache", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.20.1-beta.7",
					installedAt: "x",
					installModePreference: "plugin",
				},
			},
		});
		await writeSettings({ "ck@claudekit": true });
		await writePluginCacheFile("2.20.1-beta.5", "skills/gemini-research/SKILL.md", "retired\n");
		await mkdir(join(claudeDir, "skills", "gemini-research"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "gemini-research", "SKILL.md"), "retired\n", "utf-8");

		const r = await single();

		expect(r.status).toBe("warn");
		expect(r.message).toContain("Install mode: mixed");
		expect(r.message).toContain("--install-mode plugin");
	});

	test.each([
		["absent", null],
		["malformed", "{"],
		["empty", {}],
	] as const)("warns on cache-proven mixed state with %s metadata", async (_label, metadata) => {
		if (metadata === "{") {
			await writeFile(join(claudeDir, "metadata.json"), metadata, "utf-8");
		} else if (metadata !== null) {
			await writeMetadata(metadata);
		}
		await writeSettings({ "ck@claudekit": true });
		await writePluginCacheFile("2.20.1-beta.5", "skills/retired/SKILL.md", "retired\n");
		await mkdir(join(claudeDir, "skills", "retired"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "retired", "SKILL.md"), "retired\n", "utf-8");

		const r = await single();

		expect(r.status).toBe("warn");
		expect(r.message).toContain("Install mode: mixed");
		expect(r.message).toContain("--install-mode legacy");
	});

	test("persisted plugin consent with disabled plugin -> warn with enable hint", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					installModePreference: "plugin",
				},
			},
		});
		await writeSettings({ "ck@claudekit": false });
		const r = await single();
		expect(r.status).toBe("warn");
		expect(r.message).toContain("claude plugin enable ck");
	});

	test("disabled plugin without consent recommends normal cleanup instead of enablement", async () => {
		await writeMetadata({
			kits: { engineer: { version: "2.19.0", installedAt: "x" } },
		});
		await writeSettings({ "ck@claudekit": false });

		const r = await single();

		expect(r.status).toBe("warn");
		expect(r.message).toContain("--install-mode legacy");
		expect(r.message).not.toContain("claude plugin enable ck");
	});

	test("mixed without plugin consent -> warn with normal convergence guidance", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "# cook\n", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		await writeSettings({ "ck@claudekit": true });
		const r = await single();
		expect(r.status).toBe("warn");
		expect(r.message).toContain("mixed");
		expect(r.message).toContain("--install-mode legacy");
	});

	test("warns when Codex plugin is stale for persisted plugin consent", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.20.1-beta.7",
					installedAt: "x",
					installModePreference: "plugin",
				},
			},
		});
		await writeSettings({ "ck@claudekit": true });

		const r = await single({
			...codexUnavailable,
			status: "installed-stale-version",
			installed: true,
			enabled: true,
			installedVersion: "2.20.1-beta.6",
			expectedVersion: "2.20.1-beta.7",
			shouldRefresh: true,
		});

		expect(r.status).toBe("warn");
		expect(r.message).toContain("Codex plugin requires repair");
		expect(r.message).toContain("Codex plugin: installed-stale-version, 2.20.1-beta.6");
	});

	test.each([undefined, "auto", "unexpected"])(
		"plugin state with non-consenting preference %p recommends normal convergence",
		async (preference) => {
			await writeMetadata({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						...(preference === undefined ? {} : { installModePreference: preference }),
					},
				},
			});
			await writeSettings({ "ck@claudekit": true });

			const r = await single();

			expect(r.status).toBe("warn");
			expect(r.message).toContain("--install-mode legacy");
			expect(r.message).not.toContain("claude plugin enable ck");
		},
	);

	test("passes expected kit version and source to Codex state detection", async () => {
		await writeSettings({ "ck@claudekit": true });
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.20.1-beta.7",
					installedAt: "x",
					installModePreference: "plugin",
				},
			},
		});

		const seen: unknown[] = [];
		const results = await new PluginInstallModeChecker(claudeDir, {
			detectCodexPluginState: async (options) => {
				seen.push(options);
				return codexUnavailable;
			},
		}).run();

		expect(results[0].status).toBe("pass");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			expectedVersion: "2.20.1-beta.7",
			expectedMarketplace: "claudekit",
		});
		expect((seen[0] as { expectedSource?: string }).expectedSource).toEndWith(
			join("ck-plugin-source", ".claude"),
		);
	});

	test.each([
		["unknown", false, false],
		["missing", false, false],
		["disabled", true, false],
		["installed-stale-version", true, true],
		["installed-stale-source", true, true],
	] as const)(
		"plugin preference reports Codex %s as actionable",
		async (status, installed, refresh) => {
			await writeMetadata({
				kits: {
					engineer: {
						version: "2.20.1-beta.7",
						installedAt: "x",
						installModePreference: "plugin",
					},
				},
			});
			await writeSettings({ "ck@claudekit": true });

			const r = await single({
				...codexUnavailable,
				status,
				installed,
				enabled: status !== "disabled" && installed,
				shouldRefresh: refresh,
				...(status === "unknown" ? { error: "inspection failed" } : {}),
			});

			expect(r.status).toBe("warn");
			expect(r.message).toContain(
				status === "unknown" ? "Codex plugin inspection failed" : "Codex plugin requires repair",
			);
		},
	);

	test("Codex inspection exception is never reported as pass for plugin preference", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.20.1-beta.7",
					installedAt: "x",
					installModePreference: "plugin",
				},
			},
		});
		await writeSettings({ "ck@claudekit": true });

		const [result] = await new PluginInstallModeChecker(claudeDir, {
			detectCodexPluginState: async () => {
				throw new Error("inspection failed");
			},
		}).run();

		expect(result.status).toBe("warn");
		expect(result.message).toContain("inspection failed");
	});

	test("Codex inspection exception is never reported as pass for Normal preference", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.20.1-beta.7",
					installedAt: "x",
					installModePreference: "legacy",
				},
			},
		});

		const [result] = await new PluginInstallModeChecker(claudeDir, {
			detectCodexPluginState: async () => {
				throw new Error("inspection failed");
			},
		}).run();

		expect(result.status).toBe("warn");
		expect(result.message).toContain("Codex plugin inspection failed");
		expect(result.message).toContain("inspection failed");
	});

	test("warns when legacy preference still has an active Codex plugin", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					installModePreference: "legacy",
				},
			},
		});

		const r = await single({
			...codexUnavailable,
			status: "installed-current",
			installed: true,
			enabled: true,
			shouldRefresh: false,
		});

		expect(r.status).toBe("warn");
		expect(r.message).toContain("preference is legacy (normal skills)");
	});
});
