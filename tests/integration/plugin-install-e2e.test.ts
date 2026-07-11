import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	handlePluginInstall,
	replacePluginSourceAtomically,
	stagePluginSource,
} from "@/commands/init/phases/plugin-install-handler.js";
import type { InitContext } from "@/commands/init/types.js";
import { uninstallCommand } from "@/commands/uninstall/uninstall-command.js";
import { promptKitUpdate } from "@/commands/update/post-update-handler.js";
import { PluginInstallModeChecker } from "@/domains/health-checks/plugin-install-mode-checker.js";
import {
	CodexPluginInstaller,
	detectCodexPluginState,
	installCodexPlugin,
	removeCodexPlugin,
} from "@/domains/installation/plugin/codex-plugin-installer.js";
import { cleanupEngineerProviderPlugins } from "@/domains/installation/plugin/engineer-provider-cleanup.js";
import { detectInstallMode } from "@/domains/installation/plugin/install-mode-detector.js";
import { migrateLegacyToPlugin } from "@/domains/installation/plugin/migrate-legacy-to-plugin.js";
import { uninstallEnginePlugin } from "@/domains/installation/plugin/uninstall-plugin.js";
import {
	type FakePluginProviderHarness,
	createFakePluginProviderHarness,
} from "./helpers/fake-plugin-providers.js";

/**
 * Real end-to-end migration check (#693). Exercises the actual install path:
 * stagePluginSource (synthesized marketplace) -> migrateLegacyToPlugin -> real
 * `claude plugin` against a sandboxed CLAUDE_CONFIG_DIR. No mocks.
 *
 * Gated behind CK_RUN_CLI_INTEGRATION=1 (needs a real `claude` binary + the
 * engineer kit). ENGINEER_KIT_DIR overrides the kit `claude/` source path.
 */
const RUN = process.env.CK_RUN_CLI_INTEGRATION === "1";
const KIT_CLAUDE_DIR =
	process.env.ENGINEER_KIT_DIR ?? "/Users/kaitran/claudekit/claudekit-engineer/claude";

const describeOrSkip =
	RUN &&
	existsSync(join(KIT_CLAUDE_DIR, ".claude-plugin", "plugin.json")) &&
	commandWorks("claude", ["plugin", "--help"], /marketplace/i)
		? describe
		: describe.skip;
const describeCodexOrSkip =
	RUN &&
	existsSync(join(KIT_CLAUDE_DIR, ".codex-plugin", "plugin.json")) &&
	commandWorks("codex", ["plugin", "--help"], /marketplace/i)
		? describe
		: describe.skip;

function commandWorks(command: string, args: string[], match?: RegExp): boolean {
	try {
		const output = execFileSync(command, args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return match ? match.test(output) : true;
	} catch {
		return false;
	}
}

describe("plugin lifecycle e2e (isolated fake providers)", () => {
	let harness: FakePluginProviderHarness;

	beforeEach(() => {
		harness = createFakePluginProviderHarness();
		writeMetadata([], "legacy");
	});

	afterEach(() => {
		harness.cleanup();
	});

	function writeMetadata(
		files: Array<{ path: string; ownership?: "ck" | "user" }> = [],
		installModePreference: "legacy" | "plugin" = "plugin",
	): void {
		writeFileSync(
			join(harness.claudeDir, "metadata.json"),
			`${JSON.stringify(
				{
					kits: {
						engineer: {
							version: "2.20.1",
							installedAt: "2026-07-11T12:00:00.000Z",
							installModePreference,
							files: files.map((file) => ({
								...file,
								checksum: "0".repeat(64),
								installedVersion: "2.20.1",
							})),
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	}

	function context(installMode: "plugin" | "legacy"): InitContext {
		return {
			kitType: "engineer",
			extractDir: harness.extractDir,
			claudeDir: harness.claudeDir,
			options: { global: true, installMode },
		} as unknown as InitContext;
	}

	async function explicitPluginOptIn(): Promise<void> {
		await handlePluginInstall(context("plugin"), { stageBaseDir: harness.stageDir });
	}

	test("fresh explicit opt-in reaches current provider state and healthy doctor output", async () => {
		await explicitPluginOptIn();

		const claude = detectInstallMode(harness.claudeDir);
		expect(claude.mode).toBe("plugin");
		expect(claude.plugin).toMatchObject({ enabled: true, version: "2.20.1" });
		const codex = await detectCodexPluginState(undefined, {
			expectedVersion: "2.20.1",
			expectedSource: join(harness.stageDir, ".claude"),
		});
		expect(codex.status).toBe("installed-current");
		expect(harness.readClaudeState().marketplaceSource).toBe(harness.stageDir);
		expect(harness.readCodexState().marketplaceSource).toBe(harness.stageDir);

		const doctor = await new PluginInstallModeChecker(harness.claudeDir).run();
		expect(doctor[0]).toMatchObject({ status: "pass" });
		expect(doctor[0].message).toContain("Codex plugin: installed-current");
		expect(readFileSync(harness.userFile, "utf8")).toBe("user-owned content\n");
	});

	test("same-version unhealthy update routes through promptKitUpdate and repairs both providers", async () => {
		await explicitPluginOptIn();
		rmSync(join(harness.claudeDir, "plugins", "cache", "claudekit", "ck"), {
			recursive: true,
			force: true,
		});
		harness.writeClaudeState({ installed: true, enabled: false, version: "1.0.0" });
		harness.writeCodexState({
			marketplaceSource: harness.stageDir,
			installed: true,
			enabled: false,
			version: "1.0.0",
		});
		let spawnCalls = 0;

		await promptKitUpdate(false, true, {
			getSetupFn: async () => ({
				global: {
					path: harness.claudeDir,
					metadata: { kits: { engineer: { version: "2.20.1" } } },
					components: {
						commands: 0,
						hooks: 0,
						skills: 0,
						workflows: 0,
						settings: 0,
					},
				},
				project: {
					path: "",
					metadata: null,
					components: {
						commands: 0,
						hooks: 0,
						skills: 0,
						workflows: 0,
						settings: 0,
					},
				},
			}),
			spawnInitFn: async (args) => {
				spawnCalls += 1;
				expect(args).toContain("--install-mode");
				expect(args).toContain("plugin");
				await handlePluginInstall(context("plugin"), { stageBaseDir: harness.stageDir });
				return 0;
			},
			loadFullConfigFn: async () => ({ config: { updatePipeline: {} } }),
		});

		expect(spawnCalls).toBe(1);
		expect(detectInstallMode(harness.claudeDir).plugin).toMatchObject({
			enabled: true,
			version: "2.20.1",
		});
		expect(
			(
				await detectCodexPluginState(undefined, {
					expectedVersion: "2.20.1",
					expectedSource: join(harness.stageDir, ".claude"),
				})
			).status,
		).toBe("installed-current");
	});

	test("mixed, disabled, stale, and wrong-source providers converge without user data loss", async () => {
		await explicitPluginOptIn();
		const legacyFile = join(harness.claudeDir, "skills", "legacy-ck", "SKILL.md");
		mkdirSync(dirname(legacyFile), { recursive: true });
		writeFileSync(legacyFile, "CK-owned legacy content\n", "utf8");
		writeMetadata(
			[
				{ path: "skills/legacy-ck/SKILL.md", ownership: "ck" },
				{ path: "skills/personal/SKILL.md", ownership: "user" },
			],
			"plugin",
		);
		rmSync(join(harness.claudeDir, "plugins", "cache", "claudekit", "ck"), {
			recursive: true,
			force: true,
		});
		harness.writeClaudeState({
			marketplaceSource: join(harness.root, "old-claude-source"),
			installed: true,
			enabled: false,
			version: "1.0.0",
		});
		harness.writeCodexState({
			marketplaceSource: join(harness.root, "old-codex-source"),
			installed: true,
			enabled: true,
			version: "1.0.0",
		});
		expect(detectInstallMode(harness.claudeDir).mode).toBe("mixed");
		expect(
			(
				await detectCodexPluginState(undefined, {
					expectedSource: join(harness.stageDir, ".claude"),
				})
			).status,
		).toBe("installed-stale-source");

		const codexRepair = await installCodexPlugin({ pluginSourceDir: harness.stageDir });
		expect(codexRepair).toEqual({ action: "installed", pluginVerified: true });
		expect(harness.readCodexState()).toMatchObject({
			marketplaceSource: harness.stageDir,
			enabled: true,
			version: "2.20.1",
		});
		const claudeRepair = await migrateLegacyToPlugin({
			pluginSourceDir: harness.stageDir,
			claudeDir: harness.claudeDir,
			now: "2026-07-11T12:00:00.000Z",
		});
		expect(claudeRepair.action).toBe("migrated-from-legacy");
		expect(claudeRepair.pluginVerified).toBe(true);
		expect(existsSync(legacyFile)).toBe(false);
		expect(readFileSync(harness.userFile, "utf8")).toBe("user-owned content\n");
		expect(harness.readClaudeState()).toMatchObject({
			marketplaceSource: harness.stageDir,
			enabled: true,
			version: "2.20.1",
		});
		expect(harness.readCodexState()).toMatchObject({
			marketplaceSource: harness.stageDir,
			enabled: true,
			version: "2.20.1",
		});
		expect((await new PluginInstallModeChecker(harness.claudeDir).run())[0].status).toBe("pass");
	});

	test("global uninstall command removes both providers and repeated command remains a no-op", async () => {
		await explicitPluginOptIn();
		writeMetadata([{ path: "skills/personal/SKILL.md", ownership: "user" }], "plugin");
		const cleanupResults: Array<Awaited<ReturnType<typeof cleanupEngineerProviderPlugins>>> = [];
		const cleanupProviders = async () => {
			const result = await cleanupEngineerProviderPlugins({
				uninstallClaudePlugin: () => uninstallEnginePlugin({ claudeDir: harness.claudeDir }),
				removeCodexPlugin: () => removeCodexPlugin({ codexHome: harness.codexHome }),
				verifyClaudePluginAbsent: () => !detectInstallMode(harness.claudeDir).plugin.installed,
				readCodexPluginState: () => detectCodexPluginState(),
			});
			cleanupResults.push(result);
			return result;
		};
		const options = {
			yes: true,
			json: false,
			verbose: false,
			local: false,
			global: true,
			all: false,
			dryRun: false,
			forceOverwrite: false,
			kit: "engineer" as const,
		};

		await uninstallCommand(options, { cleanupEngineerProviderPlugins: cleanupProviders });

		expect(detectInstallMode(harness.claudeDir).plugin.installed).toBe(false);
		expect((await detectCodexPluginState()).status).toBe("missing");
		expect(readFileSync(harness.userFile, "utf8")).toBe("user-owned content\n");

		await uninstallCommand(options, { cleanupEngineerProviderPlugins: cleanupProviders });
		expect(detectInstallMode(harness.claudeDir).plugin.installed).toBe(false);
		expect((await detectCodexPluginState()).status).toBe("missing");
		expect(cleanupResults.map((result) => result.changed)).toEqual([true, false]);
	});

	test("staging and provider failures restore the previous stable source and registration", async () => {
		await explicitPluginOptIn();
		const claudeBefore = harness.readClaudeState();
		const stableMarker = join(harness.stageDir, "stable-marker.txt");
		writeFileSync(stableMarker, "stable\n", "utf8");
		let renameCount = 0;

		expect(() =>
			replacePluginSourceAtomically(join(harness.extractDir, ".claude"), harness.stageDir, {
				transactionId: "injected-failure",
				renameDirectory: (source, target) => {
					renameCount += 1;
					if (renameCount === 2) throw new Error("injected activation failure");
					renameSync(source, target);
				},
			}),
		).toThrow("injected activation failure");
		expect(readFileSync(stableMarker, "utf8")).toBe("stable\n");

		const oldSource = join(harness.root, "old-codex-source");
		mkdirSync(join(oldSource, ".claude", ".codex-plugin"), { recursive: true });
		writeFileSync(
			join(oldSource, ".claude", ".codex-plugin", "plugin.json"),
			`${JSON.stringify({ name: "ck", version: "1.0.0" })}\n`,
			"utf8",
		);
		harness.writeCodexState({
			marketplaceSource: oldSource,
			installed: true,
			enabled: true,
			version: "1.0.0",
			failPluginAddOnce: true,
		});

		const failed = await installCodexPlugin({ pluginSourceDir: harness.stageDir });
		expect(failed.action).toBe("install-failed");
		expect(failed.error).toContain("restored previous marketplace and plugin state");
		expect(harness.readCodexState()).toMatchObject({
			marketplaceSource: oldSource,
			installed: true,
			enabled: true,
			version: "1.0.0",
		});
		expect(harness.readClaudeState()).toEqual(claudeBefore);
		expect(detectInstallMode(harness.claudeDir).plugin).toMatchObject({
			enabled: true,
			version: "2.20.1",
		});
		expect(readFileSync(harness.userFile, "utf8")).toBe("user-owned content\n");
	});
});

describeOrSkip("plugin install e2e (real claude binary, sandboxed)", () => {
	let sandbox: string; // CLAUDE_CONFIG_DIR
	let extractDir: string; // simulated extracted release: <extractDir>/.claude
	let stageDir: string;

	beforeAll(() => {
		const root = join(tmpdir(), `ck-e2e-${Date.now()}`);
		sandbox = join(root, "config");
		extractDir = join(root, "extract");
		stageDir = join(root, "stage");
		mkdirSync(sandbox, { recursive: true });
		// Simulate the release archive layout: extractDir/.claude == the kit payload.
		mkdirSync(join(extractDir, ".claude"), { recursive: true });
		cpSync(KIT_CLAUDE_DIR, join(extractDir, ".claude"), { recursive: true });
	});

	afterAll(() => {
		try {
			rmSync(join(extractDir, ".."), { recursive: true, force: true });
		} catch {}
	});

	test("fresh -> installed-fresh, plugin verified, /ck:* skills load", async () => {
		const pluginSourceDir = stagePluginSource(extractDir, stageDir);
		expect(existsSync(join(pluginSourceDir, ".claude-plugin", "marketplace.json"))).toBe(true);

		const result = await migrateLegacyToPlugin({ pluginSourceDir, claudeDir: sandbox });

		expect(result.action).toBe("installed-fresh");
		expect(result.pluginVerified).toBe(true);

		// Detector now sees a real plugin install in the sandbox.
		const mode = detectInstallMode(sandbox);
		expect(mode.mode).toBe("plugin");
		expect(mode.plugin.installed).toBe(true);
		expect(mode.plugin.enabled).toBe(true);

		// Authoritative: `claude plugin details ck` lists the skills.
		const details = execFileSync("claude", ["plugin", "details", "ck"], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox },
			encoding: "utf-8",
		});
		expect(details).toMatch(/Skills \(\d{2,}\)/); // dozens of skills
	}, 120_000);
});

describeCodexOrSkip("Codex plugin install e2e (real codex binary, sandboxed)", () => {
	let codexHome: string;
	let extractDir: string;
	let stageDir: string;

	beforeAll(() => {
		const root = join(tmpdir(), `ck-codex-e2e-${Date.now()}`);
		codexHome = join(root, "codex-home");
		extractDir = join(root, "extract");
		stageDir = join(root, "stage");
		mkdirSync(codexHome, { recursive: true });
		mkdirSync(join(extractDir, ".claude"), { recursive: true });
		cpSync(KIT_CLAUDE_DIR, join(extractDir, ".claude"), { recursive: true });
	});

	afterAll(() => {
		try {
			rmSync(join(extractDir, ".."), { recursive: true, force: true });
		} catch {}
	});

	test("installs ck@claudekit from the staged Codex marketplace", async () => {
		const pluginSourceDir = stagePluginSource(extractDir, stageDir);
		expect(existsSync(join(pluginSourceDir, ".agents", "plugins", "marketplace.json"))).toBe(true);

		const result = await installCodexPlugin({ pluginSourceDir, codexHome });

		expect(result).toEqual({ action: "installed", pluginVerified: true });
		await expect(new CodexPluginInstaller(undefined, codexHome).verifyInstalled()).resolves.toBe(
			true,
		);
	}, 120_000);
});
