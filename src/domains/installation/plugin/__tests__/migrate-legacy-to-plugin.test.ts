import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

	test("rejects a preexisting symlinked backup root before removing legacy files", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const outsideBackup = join(
			tmpdir(),
			`ck-outside-backup-${Date.now()}-${Math.round(performance.now())}`,
		);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await mkdir(outsideBackup, { recursive: true });
		await writeFile(legacyFile, "legacy skill", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		await symlink(outsideBackup, join(claudeDir, "backups"), "dir");
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.action).toBe("install-failed");
		expect(result.error).toContain("unsafe backup directory");
		expect(readFileSync(legacyFile, "utf-8")).toBe("legacy skill");
		expect(await readdir(outsideBackup)).toEqual([]);
		await rm(outsideBackup, { recursive: true, force: true });
	});

	test("reports incomplete rollback when a receipt failure introduces a target symlink", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const outsideFile = join(
			tmpdir(),
			`ck-rollback-outside-${Date.now()}-${Math.round(performance.now())}.md`,
		);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "legacy skill", "utf-8");
		await writeFile(outsideFile, "outside stays", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			now: TS,
			writeReceiptFn: () => {
				symlinkSync(outsideFile, legacyFile);
				throw new Error("disk full");
			},
		});

		expect(result.action).toBe("install-failed");
		expect(result.error).toContain("rollback incomplete");
		expect(result.error).toContain("skills/cook/SKILL.md");
		expect(result.backupDir).not.toBeNull();
		expect(existsSync(join(result.backupDir as string, "skills", "cook", "SKILL.md"))).toBe(true);
		expect(readFileSync(outsideFile, "utf-8")).toBe("outside stays");
		await rm(outsideFile, { force: true });
	});

	test("never restores metadata through a symlink introduced during receipt failure", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const metadataPath = join(claudeDir, "metadata.json");
		const outsideFile = join(
			tmpdir(),
			`ck-metadata-restore-outside-${Date.now()}-${Math.round(performance.now())}.json`,
		);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "legacy skill", "utf-8");
		await writeFile(outsideFile, "outside metadata stays", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			now: TS,
			writeReceiptFn: () => {
				rmSync(metadataPath, { force: true });
				symlinkSync(outsideFile, metadataPath);
				throw new Error("disk full");
			},
		});

		expect(result.error).toContain("rollback incomplete");
		expect(result.error).toContain("metadata.json: unsafe restore target");
		expect(readFileSync(outsideFile, "utf-8")).toBe("outside metadata stays");
		expect(result.backupDir).not.toBeNull();
		await rm(outsideFile, { force: true });
	});

	test("never restores a receipt snapshot through a replacement symlink", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const receiptPath = join(claudeDir, ".ck-migration-log.json");
		const outsideFile = join(
			tmpdir(),
			`ck-receipt-restore-outside-${Date.now()}-${Math.round(performance.now())}.json`,
		);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "legacy skill", "utf-8");
		await writeFile(receiptPath, '[{"prior":true}]\n', "utf-8");
		await writeFile(outsideFile, "outside receipt stays", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			now: TS,
			writeReceiptFn: () => {
				rmSync(receiptPath, { force: true });
				symlinkSync(outsideFile, receiptPath);
				throw new Error("disk full");
			},
		});

		expect(result.error).toContain("rollback incomplete");
		expect(result.error).toContain(".ck-migration-log.json: unsafe restore target");
		expect(readFileSync(outsideFile, "utf-8")).toBe("outside receipt stays");
		await rm(outsideFile, { force: true });
	});

	test("never restores Claude provider settings through a replacement symlink", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const settingsPath = join(claudeDir, "settings.json");
		const outsideFile = join(
			tmpdir(),
			`ck-settings-restore-outside-${Date.now()}-${Math.round(performance.now())}.json`,
		);
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "legacy skill", "utf-8");
		await writeFile(settingsPath, JSON.stringify({ enabledPlugins: {} }), "utf-8");
		await writeFile(outsideFile, "outside settings stay", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "skills/cook/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/staged/kit",
			claudeDir,
			installer,
			now: TS,
			writeReceiptFn: () => {
				rmSync(settingsPath, { force: true });
				symlinkSync(outsideFile, settingsPath);
				throw new Error("disk full");
			},
		});

		expect(result.error).toContain("rollback incomplete");
		expect(result.error).toContain("settings.json: unsafe restore target");
		expect(readFileSync(outsideFile, "utf-8")).toBe("outside settings stay");
		await rm(outsideFile, { force: true });
	});

	test("same-version deprecated installedFiles converge when bytes match staged plugin payload", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const legacyAgent = join(claudeDir, "agents", "planner.md");
		const pluginSourceDir = join(claudeDir, "staged-source");
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await mkdir(join(claudeDir, "agents"), { recursive: true });
		await mkdir(join(pluginSourceDir, ".claude", "skills", "cook"), { recursive: true });
		await mkdir(join(pluginSourceDir, ".claude", "agents"), { recursive: true });
		await mkdir(join(pluginSourceDir, ".claude", ".claude-plugin"), { recursive: true });
		await writeFile(legacyFile, "historical content", "utf-8");
		await writeFile(legacyAgent, "historical agent", "utf-8");
		await writeFile(
			join(pluginSourceDir, ".claude", "skills", "cook", "SKILL.md"),
			"historical content",
			"utf-8",
		);
		await writeFile(
			join(pluginSourceDir, ".claude", "agents", "planner.md"),
			"historical agent",
			"utf-8",
		);
		await writeFile(
			join(pluginSourceDir, ".claude", ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "ck", version: "2.18.0" }),
			"utf-8",
		);
		await writeMetadata({
			name: "engineer",
			version: "2.18.0",
			installedFiles: ["skills/cook/SKILL.md", "agents/planner.md"],
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir,
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.action).toBe("migrated-from-legacy");
		expect(result.removedPaths).toEqual(["skills/cook/SKILL.md", "agents/planner.md"]);
		expect(existsSync(legacyFile)).toBe(false);
		expect(existsSync(legacyAgent)).toBe(false);
		expect(
			readFileSync(join(result.backupDir as string, "skills", "cook", "SKILL.md"), "utf-8"),
		).toBe("historical content");
		expect(readFileSync(join(result.backupDir as string, "agents", "planner.md"), "utf-8")).toBe(
			"historical agent",
		);
		const metadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(metadata.installedFiles).toEqual([]);
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace(pluginSourceDir);
		expect(detectInstallMode(claudeDir).mode).toBe("plugin");
		expect(detectInstallMode(claudeDir).legacy.installed).toBe(false);
	});

	test("mismatched deprecated installedFiles content stays mixed and actionable", async () => {
		const legacyFile = join(claudeDir, "skills", "cook", "SKILL.md");
		const pluginSourceDir = join(claudeDir, "staged-source");
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await mkdir(join(pluginSourceDir, ".claude", "skills", "cook"), { recursive: true });
		await writeFile(legacyFile, "user edited content", "utf-8");
		await writeFile(
			join(pluginSourceDir, ".claude", "skills", "cook", "SKILL.md"),
			"staged plugin content",
			"utf-8",
		);
		await writeMetadata({
			name: "engineer",
			version: "2.18.0",
			installedFiles: ["skills/cook/SKILL.md"],
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir,
			claudeDir,
			installer,
			now: TS,
		});

		expect(result.action).toBe("migrated-from-legacy");
		expect(result.removedPaths).toEqual([]);
		expect(readFileSync(legacyFile, "utf-8")).toBe("user edited content");
		const metadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(metadata.installedFiles).toEqual(["skills/cook/SKILL.md"]);
		await writeSettings({ "ck@claudekit": true });
		await writeMarketplace(pluginSourceDir);
		expect(detectInstallMode(claudeDir).mode).toBe("mixed");
		expect(detectInstallMode(claudeDir).legacy.installed).toBe(true);
	});

	test("multi-kit migration prunes nested Engineer records without touching ambiguous root records", async () => {
		const liveNested = join(claudeDir, "skills", "live-nested", "SKILL.md");
		const liveRoot = join(claudeDir, "agents", "live-root.md");
		await mkdir(join(claudeDir, "skills", "live-nested"), { recursive: true });
		await mkdir(join(claudeDir, "agents"), { recursive: true });
		await writeFile(liveNested, "live nested", "utf-8");
		await writeFile(liveRoot, "live root", "utf-8");
		await writeMetadata({
			files: [
				{ path: "agents/live-root.md", ownership: "ck" },
				{ path: "agents/removed-root.md", ownership: "ck" },
			],
			installedFiles: ["agents/live-root.md", "agents/removed-root.md"],
			kits: {
				engineer: {
					files: [
						{ path: "skills/live-nested/SKILL.md", ownership: "ck" },
						{ path: "skills/removed-nested/SKILL.md", ownership: "ck" },
					],
					installedFiles: ["skills/live-nested/SKILL.md", "skills/removed-nested/SKILL.md"],
				},
				marketing: {
					files: [{ path: "skills/marketing/SKILL.md", ownership: "ck" }],
				},
			},
		});
		const { installer } = fakeInstaller();

		const result = await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => ["skills/removed-nested/SKILL.md"],
			now: TS,
		});

		expect(result.action).toBe("migrated-from-legacy");
		const metadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(metadata.kits.engineer.files).toEqual([
			{ path: "skills/live-nested/SKILL.md", ownership: "ck" },
		]);
		expect(metadata.kits.engineer.installedFiles).toEqual(["skills/live-nested/SKILL.md"]);
		expect(metadata.files).toEqual([
			{ path: "agents/live-root.md", ownership: "ck" },
			{ path: "agents/removed-root.md", ownership: "ck" },
		]);
		expect(metadata.installedFiles).toEqual(["agents/live-root.md", "agents/removed-root.md"]);
		expect(metadata.kits.marketing.files).toEqual([
			{ path: "skills/marketing/SKILL.md", ownership: "ck" },
		]);
		expect(readFileSync(liveNested, "utf-8")).toBe("live nested");
		expect(readFileSync(liveRoot, "utf-8")).toBe("live root");
	});

	test("sole-Engineer migration prunes both nested and transitional root records", async () => {
		await mkdir(join(claudeDir, "skills", "live"), { recursive: true });
		await mkdir(join(claudeDir, "agents"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "live", "SKILL.md"), "live", "utf-8");
		await writeFile(join(claudeDir, "agents", "live.md"), "live", "utf-8");
		await writeMetadata({
			files: [
				{ path: "agents/live.md", ownership: "ck" },
				{ path: "agents/removed.md", ownership: "ck" },
			],
			installedFiles: ["agents/live.md", "agents/removed.md"],
			kits: {
				engineer: {
					files: [
						{ path: "skills/live/SKILL.md", ownership: "ck" },
						{ path: "skills/removed/SKILL.md", ownership: "ck" },
					],
				},
			},
		});
		const { installer } = fakeInstaller();

		await migrateLegacyToPlugin({
			pluginSourceDir: "/src",
			claudeDir,
			installer,
			removeLegacy: () => ["skills/removed/SKILL.md", "agents/removed.md"],
			now: TS,
		});

		const metadata = JSON.parse(readFileSync(join(claudeDir, "metadata.json"), "utf-8"));
		expect(metadata.kits.engineer.files).toEqual([
			{ path: "skills/live/SKILL.md", ownership: "ck" },
		]);
		expect(metadata.files).toEqual([{ path: "agents/live.md", ownership: "ck" }]);
		expect(metadata.installedFiles).toEqual(["agents/live.md"]);
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

	for (const ownership of ["ck", "user", "unknown"] as const) {
		test(`preserves ${ownership}-owned files reached through a symlink component`, async () => {
			const outsideDir = join(
				tmpdir(),
				`ck-rm-outside-${ownership}-${Date.now()}-${Math.round(performance.now())}`,
			);
			extraCleanupPaths.push(outsideDir);
			await mkdir(outsideDir, { recursive: true });
			await writeFile(join(outsideDir, "SKILL.md"), "outside content", "utf-8");
			await symlink(outsideDir, join(claudeDir, "skills", "linked"), "dir");
			const tracked = {
				path: "skills/linked/SKILL.md",
				ownership,
				...(ownership === "user" ? { checksum: sha256("outside content") } : {}),
			};
			await writeFile(
				join(claudeDir, "metadata.json"),
				JSON.stringify({ kits: { engineer: { files: [tracked] } } }),
				"utf-8",
			);
			const pluginSourceDir = join(claudeDir, "staged-source");
			if (ownership === "unknown") {
				await mkdir(join(pluginSourceDir, ".claude", "skills", "linked"), { recursive: true });
				await writeFile(
					join(pluginSourceDir, ".claude", "skills", "linked", "SKILL.md"),
					"outside content",
					"utf-8",
				);
			}

			const removed = defaultLegacyRemover(claudeDir, backupDir, pluginSourceDir);

			expect(removed).toEqual([]);
			expect(readFileSync(join(outsideDir, "SKILL.md"), "utf-8")).toBe("outside content");
			expect(existsSync(join(backupDir, "skills", "linked", "SKILL.md"))).toBe(false);
		});
	}

	test("rejects unknown ownership proof reached through a staged-source symlink", async () => {
		const outsideDir = join(
			tmpdir(),
			`ck-rm-staged-outside-${Date.now()}-${Math.round(performance.now())}`,
		);
		extraCleanupPaths.push(outsideDir);
		await mkdir(outsideDir, { recursive: true });
		await writeFile(join(outsideDir, "SKILL.md"), "matching content", "utf-8");
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "matching content", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({ installedFiles: ["skills/cook/SKILL.md"] }),
			"utf-8",
		);
		const pluginSourceDir = join(claudeDir, "staged-source");
		await mkdir(join(pluginSourceDir, ".claude", "skills"), { recursive: true });
		await symlink(outsideDir, join(pluginSourceDir, ".claude", "skills", "cook"), "dir");

		const removed = defaultLegacyRemover(claudeDir, backupDir, pluginSourceDir);

		expect(removed).toEqual([]);
		expect(readFileSync(join(claudeDir, "skills", "cook", "SKILL.md"), "utf-8")).toBe(
			"matching content",
		);
		expect(readFileSync(join(outsideDir, "SKILL.md"), "utf-8")).toBe("matching content");
	});

	test("preserves a structured CK-owned directory and all untracked descendants", async () => {
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "tracked", "utf-8");
		await writeFile(join(claudeDir, "skills", "cook", "notes.txt"), "untracked", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				kits: { engineer: { files: [{ path: "skills/cook", ownership: "ck" }] } },
			}),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir);

		expect(removed).toEqual([]);
		expect(readFileSync(join(claudeDir, "skills", "cook", "SKILL.md"), "utf-8")).toBe("tracked");
		expect(readFileSync(join(claudeDir, "skills", "cook", "notes.txt"), "utf-8")).toBe("untracked");
		expect(existsSync(join(backupDir, "skills", "cook"))).toBe(false);
	});

	test("legacy root installedFiles require exact staged plugin bytes before deletion", async () => {
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "historical", "utf-8");
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({ installedFiles: ["skills/cook/SKILL.md"] }),
			"utf-8",
		);

		const removedWithoutSource = defaultLegacyRemover(claudeDir, backupDir);

		expect(removedWithoutSource).toEqual([]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(true);

		const pluginSourceDir = join(claudeDir, "staged-source");
		await mkdir(join(pluginSourceDir, ".claude", "skills", "cook"), { recursive: true });
		await writeFile(
			join(pluginSourceDir, ".claude", "skills", "cook", "SKILL.md"),
			"historical",
			"utf-8",
		);

		const removedWithProof = defaultLegacyRemover(claudeDir, backupDir, pluginSourceDir);

		expect(removedWithProof).toEqual(["skills/cook/SKILL.md"]);
		expect(existsSync(join(claudeDir, "skills", "cook", "SKILL.md"))).toBe(false);
		expect(readFileSync(join(backupDir, "skills", "cook", "SKILL.md"), "utf-8")).toBe("historical");
	});

	test("historical proof never authorizes runtime or untracked file deletion", async () => {
		const pluginSourceDir = join(claudeDir, "staged-source");
		await mkdir(join(claudeDir, "hooks"), { recursive: true });
		await mkdir(join(pluginSourceDir, ".claude", "hooks"), { recursive: true });
		await mkdir(join(pluginSourceDir, ".claude", "skills", "mine"), { recursive: true });
		await writeFile(join(claudeDir, "hooks", "session-init.cjs"), "same runtime", "utf-8");
		await writeFile(
			join(pluginSourceDir, ".claude", "hooks", "session-init.cjs"),
			"same runtime",
			"utf-8",
		);
		await writeFile(join(claudeDir, "skills", "mine", "SKILL.md"), "same untracked", "utf-8");
		await writeFile(
			join(pluginSourceDir, ".claude", "skills", "mine", "SKILL.md"),
			"same untracked",
			"utf-8",
		);
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({ installedFiles: ["hooks/session-init.cjs"] }),
			"utf-8",
		);

		const removed = defaultLegacyRemover(claudeDir, backupDir, pluginSourceDir);

		expect(removed).toEqual([]);
		expect(readFileSync(join(claudeDir, "hooks", "session-init.cjs"), "utf-8")).toBe(
			"same runtime",
		);
		expect(readFileSync(join(claudeDir, "skills", "mine", "SKILL.md"), "utf-8")).toBe(
			"same untracked",
		);
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
