import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstallMode } from "@/domains/installation/plugin/install-mode-detector.js";
import {
	defaultLegacyRemover,
	migrateLegacyToPlugin,
} from "@/domains/installation/plugin/migrate-legacy-to-plugin.js";
import {
	type ClaudeRunResult,
	type ClaudeRunner,
	PluginInstaller,
} from "@/domains/installation/plugin/plugin-installer.js";

const TS = "2026-06-16T00:00:00.000Z";

function ok(stdout: string, success = true): ClaudeRunResult {
	return { ok: success, stdout, stderr: "", code: success ? 0 : 1 };
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Fake installer scripted by command; records argv. */
function fakeInstaller(
	opts: {
		claudeAvailable?: boolean;
		pluginSupported?: boolean;
		verified?: boolean;
		installOk?: boolean;
		updateOk?: boolean;
		marketplaceAddOk?: boolean;
		marketplaceUpdateOk?: boolean;
		enableOk?: boolean;
	} = {},
) {
	const calls: string[][] = [];
	const runner: ClaudeRunner = async (args) => {
		calls.push(args);
		const a = args.join(" ");
		if (a === "--version") return ok("2.1.178", opts.claudeAvailable !== false);
		if (a === "plugin --help")
			return ok(opts.pluginSupported !== false ? "Manage marketplaces" : "no plugins");
		if (a === "plugin list")
			return ok(opts.verified !== false ? "ck@claudekit Status: enabled" : "No plugins installed.");
		if (a === "plugin marketplace add /src" || a === "plugin marketplace add /staged/kit")
			return ok("", opts.marketplaceAddOk !== false);
		if (a === "plugin marketplace update claudekit")
			return ok("", opts.marketplaceUpdateOk !== false);
		if (a === "plugin install ck@claudekit --scope user") return ok("", opts.installOk !== false);
		if (a === "plugin update ck@claudekit") return ok("", opts.updateOk !== false);
		if (a === "plugin enable ck@claudekit") return ok("", opts.enableOk !== false);
		return ok("");
	};
	return { installer: new PluginInstaller(runner), calls };
}

describe("migrateLegacyToPlugin (orchestration)", () => {
	let claudeDir: string;

	beforeEach(async () => {
		claudeDir = join(tmpdir(), `ck-migrate-${Date.now()}-${Math.round(performance.now())}`);
		await mkdir(claudeDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(claudeDir, { recursive: true, force: true });
	});

	const writeMetadata = (obj: unknown) =>
		writeFile(join(claudeDir, "metadata.json"), JSON.stringify(obj), "utf-8");
	const writeSettings = (enabledPlugins: Record<string, boolean>) =>
		writeFile(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins }), "utf-8");
	const writeMarketplace = async (source = "/src") => {
		await mkdir(join(claudeDir, "plugins"), { recursive: true });
		await writeFile(
			join(claudeDir, "plugins", "known_marketplaces.json"),
			JSON.stringify({ claudekit: { installLocation: source } }),
			"utf-8",
		);
	};

	test("already plugin -> noop, no install calls", async () => {
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace();
		const { installer, calls } = fakeInstaller();
		let removerCalled = false;
		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => {
				removerCalled = true;
				return [];
			},
			now: TS,
		});
		expect(r.action).toBe("noop-already-plugin");
		expect(calls.length).toBe(0);
		expect(removerCalled).toBe(false);
	});

	test("already plugin -> prunes stale plugin-supplied legacy metadata", async () => {
		await mkdir(join(claudeDir, "hooks"), { recursive: true });
		await writeFile(join(claudeDir, "hooks", "session-init.cjs"), "runtime hook", "utf-8");
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace();
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					files: [
						{
							path: "skills/cook/SKILL.md",
							ownership: "ck",
							checksum: sha256("plugin materialized"),
							installedVersion: "2.19.0",
						},
						{
							path: "hooks/session-init.cjs",
							ownership: "ck",
							checksum: sha256("runtime hook"),
							installedVersion: "2.19.0",
						},
					],
				},
			},
		});

		const { installer, calls } = fakeInstaller();
		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => {
				throw new Error("legacy remover should not run for plugin-only mode");
			},
			now: TS,
		});

		expect(r.action).toBe("noop-already-plugin");
		expect(calls.length).toBe(0);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(false);
		expect(existsSync(join(claudeDir, "hooks", "session-init.cjs"))).toBe(true);
		const updatedMetadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(updatedMetadata.kits.engineer.files.map((file: { path: string }) => file.path)).toEqual([
			"hooks/session-init.cjs",
		]);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "plugin materialized", "utf-8");
		expect(detectInstallMode(claudeDir).mode).toBe("plugin");
	});

	test("plugin-only disabled registration is enabled and refreshed", async () => {
		await writeSettings({ "ck@claudekit": false });
		await writeMarketplace();
		const { installer, calls } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.pluginVerified).toBe(true);
		expect(calls).toContainEqual(["plugin", "enable", "ck@claudekit"]);
		expect(calls).toContainEqual(["plugin", "update", "ck@claudekit"]);
	});

	test("plugin-only stale marketplace source is refreshed", async () => {
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace("/old-source");
		const { installer, calls } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.pluginVerified).toBe(true);
		expect(calls).toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
		expect(calls).toContainEqual(["plugin", "marketplace", "add", "/src"]);
		expect(calls).toContainEqual(["plugin", "update", "ck@claudekit"]);
	});

	test("plugin-only stale version is refreshed from the staged manifest", async () => {
		const stagedSource = join(claudeDir, "staged-source");
		await mkdir(join(stagedSource, ".claude", ".claude-plugin"), { recursive: true });
		await writeFile(
			join(stagedSource, ".claude", ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "ck", version: "2.20.1" }),
			"utf-8",
		);
		await mkdir(join(claudeDir, "plugins", "cache", "claudekit", "ck", "2.19.0"), {
			recursive: true,
		});
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace(stagedSource);
		const { installer, calls } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: stagedSource,
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.pluginVerified).toBe(true);
		expect(calls).toContainEqual(["plugin", "update", "ck@claudekit"]);
	});

	test("malformed Claude marketplace replacement failure restores registration bytes", async () => {
		await writeSettings({ "ck@claudekit": true });
		await mkdir(join(claudeDir, "plugins"), { recursive: true });
		const registryPath = join(claudeDir, "plugins", "known_marketplaces.json");
		await writeFile(registryPath, "{malformed", "utf-8");
		const { installer, calls } = fakeInstaller({
			marketplaceAddOk: false,
			marketplaceUpdateOk: false,
		});

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.action).toBe("install-failed");
		expect(readFileSync(registryPath, "utf-8")).toBe("{malformed");
		expect(calls).toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
	});

	test("recovers malformed Claude marketplace registration to the staged source", async () => {
		await writeSettings({ "ck@claudekit": true });
		await mkdir(join(claudeDir, "plugins"), { recursive: true });
		const registryPath = join(claudeDir, "plugins", "known_marketplaces.json");
		await writeFile(registryPath, "{malformed", "utf-8");
		const calls: string[][] = [];
		const installer = new PluginInstaller(async (args) => {
			calls.push(args);
			const command = args.join(" ");
			if (command === "--version") return ok("2.1.178");
			if (command === "plugin --help") return ok("Manage marketplaces");
			if (command === "plugin marketplace remove claudekit") {
				await writeFile(registryPath, "{}\n", "utf-8");
				return ok("");
			}
			if (command === "plugin marketplace add /src") {
				await writeFile(
					registryPath,
					JSON.stringify({ claudekit: { installLocation: "/src" } }),
					"utf-8",
				);
				return ok("");
			}
			if (command === "plugin update ck@claudekit") return ok("");
			if (command === "plugin list") return ok("ck@claudekit Status: enabled");
			return ok("");
		});

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.pluginVerified).toBe(true);
		expect(JSON.parse(readFileSync(registryPath, "utf-8"))).toEqual({
			claudekit: { installLocation: "/src" },
		});
		expect(calls).toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
		expect(calls).toContainEqual(["plugin", "marketplace", "add", "/src"]);
	});

	test("cc without plugin support -> skipped (caller falls back to legacy copy)", async () => {
		await writeMetadata({ kits: { engineer: { version: "2.19.0", installedAt: "x", files: [] } } });
		const { installer } = fakeInstaller({ pluginSupported: false });
		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => [],
			now: TS,
		});
		expect(r.action).toBe("skipped-cc-unsupported");
		expect(r.pluginVerified).toBe(false);
	});

	test("install verify fails -> install-failed, legacy NOT touched (rollback-safe ordering)", async () => {
		await writeMetadata({ kits: { engineer: { version: "2.19.0", installedAt: "x", files: [] } } });
		const { installer } = fakeInstaller({ verified: false });
		let removerCalled = false;
		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => {
				removerCalled = true;
				return [];
			},
			now: TS,
		});
		expect(r.action).toBe("install-failed");
		expect(r.pluginVerified).toBe(false);
		expect(removerCalled).toBe(false); // destructive step gated behind verify
	});

	test("fresh -> installed-fresh, no removal, receipt written", async () => {
		const { installer } = fakeInstaller();
		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => ["x"],
			now: TS,
		});
		expect(r.action).toBe("installed-fresh");
		expect(r.removedPaths).toEqual([]);
		expect(r.receiptPath).not.toBeNull();
		expect(existsSync(join(claudeDir, ".ck-migration-log.json"))).toBe(true);
	});

	test("legacy -> migrated, remover invoked, backup dir + receipt created", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "legacy skill", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const { installer, calls } = fakeInstaller();
		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			removeLegacy: () => ["skills/cook/SKILL.md"],
			now: TS,
		});
		expect(r.action).toBe("migrated-from-legacy");
		expect(r.removedPaths).toEqual(["skills/cook/SKILL.md"]);
		expect(r.backupDir).toContain("ck-legacy-");
		expect(existsSync(r.backupDir as string)).toBe(true);
		// marketplace add used the staged source dir
		expect(calls.some((c) => c.join(" ") === "plugin marketplace add /staged/kit")).toBe(true);
		const receipt = JSON.parse(readFileSync(r.receiptPath as string, "utf-8"));
		expect(receipt[0].fromMode).toBe("legacy");
		expect(receipt[0].toMode).toBe("plugin");
	});

	test("late receipt failure restores removed legacy files and metadata", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "legacy skill", "utf-8");
		const metadata = {
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		};
		await writeMetadata(metadata);
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			now: TS,
			writeReceiptFn: () => {
				throw new Error("disk full");
			},
		});

		expect(result).toMatchObject({
			action: "install-failed",
			pluginVerified: false,
			error: "plugin migration transaction failed: disk full",
		});
		expect(readFileSync(legacyFile, "utf-8")).toBe("legacy skill");
		expect(JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"))).toEqual(metadata);
		expect(existsSync(join(claudeDir, ".ck-migration-log.json"))).toBe(false);
	});

	test("deprecated string installedFiles converge without deleting their payload", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "historical content", "utf-8");
		await writeMetadata({
			name: "engineer",
			version: "2.18.0",
			installedFiles: ["skills/cook/SKILL.md"],
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.action).toBe("migrated-from-legacy");
		expect(existsSync(legacyFile)).toBe(true);
		const metadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(metadata.installedFiles).toEqual([]);
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace();
		expect(detectInstallMode(claudeDir).mode).toBe("plugin");
		expect(detectInstallMode(claudeDir).legacy.installed).toBe(false);
	});

	test("mixed already-installed plugin refreshes plugin and still cleans legacy skills", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await mkdir(join(claudeDir, "hooks"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "legacy skill", "utf-8");
		await writeFile(join(claudeDir, "hooks", "session-init.cjs"), "runtime hook", "utf-8");
		await writeSettings({ "ck@claudekit": true });
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					installedAt: "x",
					files: [
						{ path: "skills/cook/SKILL.md", ownership: "ck" },
						{ path: "skills/missing/SKILL.md", ownership: "ck" },
						{ path: "hooks/session-init.cjs", ownership: "ck" },
					],
				},
			},
		});
		const { installer, calls } = fakeInstaller({ installOk: false, marketplaceAddOk: false });

		const r = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			now: TS,
		});

		expect(r.action).toBe("migrated-from-legacy");
		expect(r.removedPaths).toEqual(["skills/cook/SKILL.md"]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(false);
		expect(existsSync(join(claudeDir, "hooks", "session-init.cjs"))).toBe(true);
		const updatedMetadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(updatedMetadata.kits.engineer.files.map((file: { path: string }) => file.path)).toEqual([
			"hooks/session-init.cjs",
		]);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "plugin materialized", "utf-8");
		expect(detectInstallMode(claudeDir).mode).toBe("plugin");
		expect(calls).toContainEqual(["plugin", "marketplace", "update", "claudekit"]);
		expect(calls).toContainEqual(["plugin", "update", "ck@claudekit"]);
		expect(calls).not.toContainEqual(["plugin", "install", "ck@claudekit", "--scope", "user"]);
	});
});

describe("defaultLegacyRemover", () => {
	let claudeDir: string;
	let backupDir: string;
	let extraCleanupPaths: string[];
	beforeEach(async () => {
		claudeDir = join(tmpdir(), `ck-rm-${Date.now()}-${Math.round(performance.now())}`);
		backupDir = join(claudeDir, "backup");
		extraCleanupPaths = [];
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await mkdir(join(claudeDir, "skills", "mine"), { recursive: true });
		await mkdir(backupDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(claudeDir, { recursive: true, force: true });
		for (const cleanupPath of extraCleanupPaths) {
			await rm(cleanupPath, { recursive: true, force: true });
		}
	});

	test("removes ck-owned files, backs them up, preserves user-owned", async () => {
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "ck skill", "utf-8");
		await mkdir(join(claudeDir, "agents"), { recursive: true });
		await writeFile(join(claudeDir, "agents", "planner.md"), "ck agent", "utf-8");
		await writeFile(join(claudeDir, "skills", "mine", "SKILL.md"), "user skill", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [
							{ path: "skills/cook/SKILL.md", ownership: "ck" },
							{ path: "agents/planner.md", ownership: "ck" },
							{ path: "skills/mine/SKILL.md", ownership: "user" },
						],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual(["skills/cook/SKILL.md", "agents/planner.md"]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(false); // ck removed
		expect(existsSync(join(claudeDir, "agents", "planner.md"))).toBe(false); // ck removed
		expect(existsSync(join(claudeDir, "skills", "mine", "SKILL.md"))).toBe(true); // user preserved
		expect(existsSync(join(backupDir, "skills", "cook", "SKILL.md"))).toBe(true); // backed up
		expect(existsSync(join(backupDir, "agents", "planner.md"))).toBe(true); // backed up
	});

	test("legacy root installedFiles are evidence only and never deletion authority", async () => {
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "historical", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({ installedFiles: ["skills/cook/SKILL.md"] }),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual([]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(true);
	});

	test("checksum-less records stay while explicitly CK-owned records can be removed", async () => {
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "unknown", "utf-8");
		await mkdir(join(claudeDir, "skills", "safe"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "safe", "SKILL.md"), "safe", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				files: [
					{ path: "skills/cook/SKILL.md" },
					{ path: "skills/safe/SKILL.md", ownership: "ck" },
				],
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual(["skills/safe/SKILL.md"]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(true);
		expect(existsSync(join(claudeDir, "skills", "safe", "SKILL.md"))).toBe(false);
	});

	test("removes unmodified plugin-supplied files marked user-owned by manifestless installs", async () => {
		const skillContent = "offline skill";
		const agentContent = "offline agent";
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), skillContent, "utf-8");
		await mkdir(join(claudeDir, "agents"), { recursive: true });
		await writeFile(join(claudeDir, "agents", "planner.md"), agentContent, "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "local",
						installedAt: "x",
						files: [
							{
								path: "skills/cook/SKILL.md",
								ownership: "user",
								checksum: sha256(skillContent),
							},
							{
								path: "agents/planner.md",
								ownership: "user",
								checksum: sha256(agentContent),
							},
						],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual(["skills/cook/SKILL.md", "agents/planner.md"]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(false);
		expect(existsSync(join(claudeDir, "agents", "planner.md"))).toBe(false);
		expect(existsSync(join(backupDir, "skills", "cook", "SKILL.md"))).toBe(true);
		expect(existsSync(join(backupDir, "agents", "planner.md"))).toBe(true);
	});

	test("removes orphaned legacy sentinels after plugin-supplied files are removed", async () => {
		await mkdir(join(claudeDir, "skills", "cook", "scripts"), { recursive: true });
		await writeFile(join(claudeDir, "skills", ".gitignore"), "sentinel", "utf-8");
		await writeFile(
			join(claudeDir, "skills", "cook", "scripts", ".gitignore"),
			"sentinel",
			"utf-8",
		);
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "ck skill", "utf-8");
		await writeFile(join(claudeDir, "skills", "cook", "scripts", "tool.js"), "tool", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [
							{ path: "skills/cook/SKILL.md", ownership: "ck" },
							{ path: "skills/cook/scripts/tool.js", ownership: "ck" },
						],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual([
			"skills/cook/SKILL.md",
			"skills/cook/scripts/tool.js",
			"skills/.gitignore",
			"skills/cook/scripts/.gitignore",
		]);
		expect(existsSync(join(claudeDir, "skills", ".gitignore"))).toBe(false);
		expect(existsSync(join(claudeDir, "skills", "cook", "scripts", ".gitignore"))).toBe(false);
		expect(existsSync(join(backupDir, "skills", ".gitignore"))).toBe(true);
		expect(existsSync(join(backupDir, "skills", "cook", "scripts", ".gitignore"))).toBe(true);
	});

	test("preserves legacy sentinels when user content remains in the same subtree", async () => {
		await writeFile(join(claudeDir, "skills", ".gitignore"), "sentinel", "utf-8");
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "ck skill", "utf-8");
		await writeFile(join(claudeDir, "skills", "mine", "SKILL.md"), "user skill", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [
							{ path: "skills/cook/SKILL.md", ownership: "ck" },
							{ path: "skills/mine/SKILL.md", ownership: "user" },
						],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual(["skills/cook/SKILL.md"]);
		expect(existsSync(join(claudeDir, "skills", ".gitignore"))).toBe(true);
		expect(existsSync(join(claudeDir, "skills", "mine", "SKILL.md"))).toBe(true);
		expect(existsSync(join(backupDir, "skills", ".gitignore"))).toBe(false);
	});

	test("preserves modified user-owned plugin-supplied files", async () => {
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "edited skill", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "local",
						installedAt: "x",
						files: [
							{
								path: "skills/cook/SKILL.md",
								ownership: "user",
								checksum: sha256("original skill"),
							},
						],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual([]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(true);
		expect(existsSync(join(backupDir, "skills", "cook", "SKILL.md"))).toBe(false);
	});

	test("does not remove metadata paths that escape the Claude directory", async () => {
		const outsideName = `ck-outside-${Date.now()}-${Math.round(performance.now())}.txt`;
		const outsidePath = join(claudeDir, "..", outsideName);
		extraCleanupPaths.push(outsidePath);
		await writeFile(outsidePath, "outside", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [{ path: `skills/../../${outsideName}`, ownership: "ck" }],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual([]);
		expect(existsSync(outsidePath)).toBe(true);
		expect(existsSync(join(backupDir, outsideName))).toBe(false);
	});

	test("does not remove paths that resolve outside plugin-supplied legacy roots", async () => {
		await writeFile(join(claudeDir, "settings.json"), "settings", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [{ path: "skills/../settings.json", ownership: "ck" }],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual([]);
		expect(existsSync(join(claudeDir, "settings.json"))).toBe(true);
		expect(existsSync(join(backupDir, "settings.json"))).toBe(false);
	});

	test("preserves runtime files that the plugin format does not supply yet", async () => {
		await mkdir(join(claudeDir, "hooks"), { recursive: true });
		await mkdir(join(claudeDir, "rules"), { recursive: true });
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "hooks", "session-init.cjs"), "hook", "utf-8");
		await writeFile(join(claudeDir, "rules", "team.md"), "rules", "utf-8");
		await writeFile(join(claudeDir, "statusline.cjs"), "status", "utf-8");
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "skill", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [
							{ path: "hooks/session-init.cjs", ownership: "ck" },
							{ path: "rules/team.md", ownership: "ck" },
							{ path: "statusline.cjs", ownership: "ck" },
							{ path: "skills/cook/SKILL.md", ownership: "ck" },
						],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual(["skills/cook/SKILL.md"]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(false);
		expect(existsSync(join(claudeDir, "hooks", "session-init.cjs"))).toBe(true);
		expect(existsSync(join(claudeDir, "rules", "team.md"))).toBe(true);
		expect(existsSync(join(claudeDir, "statusline.cjs"))).toBe(true);
		expect(existsSync(join(backupDir, "hooks", "session-init.cjs"))).toBe(false);
	});

	test("multi-kit: removes ONLY engineer kit files, never another kit's files", async () => {
		await mkdir(join(claudeDir, "skills", "engskill"), { recursive: true });
		await mkdir(join(claudeDir, "skills", "mktskill"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "engskill", "SKILL.md"), "eng", "utf-8");
		await writeFile(join(claudeDir, "skills", "mktskill", "SKILL.md"), "mkt", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: {
					engineer: {
						version: "2.19.0",
						installedAt: "x",
						files: [{ path: "skills/engskill/SKILL.md", ownership: "ck" }],
					},
					marketing: {
						version: "1.0.0",
						installedAt: "x",
						files: [{ path: "skills/mktskill/SKILL.md", ownership: "ck" }],
					},
				},
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual(["skills/engskill/SKILL.md"]); // engineer only
		expect(existsSync(join(claudeDir, "skills", "engskill", "SKILL.md"))).toBe(false);
		expect(existsSync(join(claudeDir, "skills", "mktskill", "SKILL.md"))).toBe(true); // marketing untouched
	});
});
