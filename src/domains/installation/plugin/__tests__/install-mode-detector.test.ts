import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	classifyInstallMode,
	detectInstallMode,
	detectLegacyState,
	detectPluginState,
	hasTrackedPluginSuppliedLegacyFiles,
	resolveInstalledPluginCacheRoot,
	resolveInstalledPluginCacheSubpath,
} from "@/domains/installation/plugin/install-mode-detector.js";

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

describe("install-mode-detector", () => {
	let claudeDir: string;

	beforeEach(async () => {
		claudeDir = join(tmpdir(), `ck-mode-${Date.now()}-${Math.round(performance.now())}`);
		await mkdir(claudeDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(claudeDir, { recursive: true, force: true });
	});

	async function writeSettings(enabledPlugins: Record<string, boolean>): Promise<void> {
		await writeFile(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins }), "utf-8");
	}

	async function writeMetadata(obj: unknown): Promise<void> {
		await writeFile(join(claudeDir, "metadata.json"), JSON.stringify(obj), "utf-8");
	}

	async function makePluginCache(marketplace: string, version: string): Promise<void> {
		await mkdir(join(claudeDir, "plugins", "cache", marketplace, "ck", version), {
			recursive: true,
		});
	}

	async function writePluginCacheFile(
		version: string,
		relativePath: string,
		content: string,
	): Promise<void> {
		const versionRoot = join(claudeDir, "plugins", "cache", "claudekit", "ck", version);
		await writePluginCacheManifest(version);
		const cacheFile = join(versionRoot, relativePath);
		await mkdir(dirname(cacheFile), { recursive: true });
		await writeFile(cacheFile, content, "utf-8");
	}

	async function writePluginCacheManifest(
		version: string,
		manifest: unknown = { name: "ck", version },
	): Promise<void> {
		const manifestPath = join(
			claudeDir,
			"plugins",
			"cache",
			"claudekit",
			"ck",
			version,
			".claude-plugin",
			"plugin.json",
		);
		await mkdir(dirname(manifestPath), { recursive: true });
		await writeFile(
			manifestPath,
			typeof manifest === "string" ? manifest : JSON.stringify(manifest),
			"utf-8",
		);
	}

	async function writePluginCachePayloadWithoutManifest(
		version: string,
		relativePath: string,
		content: string,
	): Promise<void> {
		const cacheFile = join(claudeDir, "plugins", "cache", "claudekit", "ck", version, relativePath);
		await mkdir(dirname(cacheFile), { recursive: true });
		await writeFile(cacheFile, content, "utf-8");
	}

	test("fresh: no settings, no metadata, no cache", () => {
		const report = detectInstallMode(claudeDir);
		expect(report.mode).toBe("fresh");
		expect(report.plugin.installed).toBe(false);
		expect(report.legacy.installed).toBe(false);
	});

	test("legacy: multi-kit metadata with kits.engineer", async () => {
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
		const legacy = detectLegacyState(claudeDir);
		expect(legacy.installed).toBe(true);
		expect(legacy.version).toBe("2.19.0");
		expect(detectInstallMode(claudeDir).mode).toBe("legacy");
	});

	test("legacy: single-kit format with version + files", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "# cook\n", "utf-8");
		await writeMetadata({
			name: "claudekit-engineer",
			version: "2.18.0",
			files: [{ path: "skills/cook/SKILL.md" }],
		});
		expect(detectLegacyState(claudeDir).installed).toBe(true);
		expect(detectInstallMode(claudeDir).mode).toBe("legacy");
	});

	test("legacy: deprecated root installedFiles still triggers convergence", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "# cook\n", "utf-8");
		await writeMetadata({
			name: "claudekit-engineer",
			version: "2.17.0",
			installedFiles: ["skills/cook/SKILL.md"],
		});

		expect(detectLegacyState(claudeDir)).toEqual({ installed: true, version: "2.17.0" });
		expect(detectInstallMode(claudeDir).mode).toBe("legacy");
	});

	test("legacy: checksum-less structured records trigger convergence without ownership inference", async () => {
		await mkdir(join(claudeDir, "skills", "user"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "user", "SKILL.md"), "# user\n", "utf-8");
		await writeMetadata({
			name: "claudekit-engineer",
			version: "2.17.0",
			files: [{ path: "skills/user/SKILL.md" }],
		});

		expect(detectInstallMode(claudeDir).mode).toBe("legacy");
	});

	test("legacy: metadata without files or engineer kit is NOT legacy", async () => {
		await writeMetadata({ name: "claudekit-engineer", version: "2.18.0" });
		expect(detectLegacyState(claudeDir).installed).toBe(false);
	});

	test("plugin: enabled via settings.enabledPlugins", async () => {
		await writeSettings({ "ck@claudekit": true });
		const plugin = detectPluginState(claudeDir);
		expect(plugin.installed).toBe(true);
		expect(plugin.enabled).toBe(true);
		expect(plugin.marketplace).toBe("claudekit");
		expect(detectInstallMode(claudeDir).mode).toBe("plugin");
	});

	test("plugin: installed but disabled (settings false)", async () => {
		await writeSettings({ "ck@claudekit": false });
		const plugin = detectPluginState(claudeDir);
		expect(plugin.installed).toBe(true);
		expect(plugin.enabled).toBe(false);
	});

	test("plugin: orphaned cache (no settings entry) is staleCache, NOT installed", async () => {
		// uninstall removes the enabledPlugins registration but leaves the cached payload
		await makePluginCache("claudekit", "87a174162601");
		const plugin = detectPluginState(claudeDir);
		expect(plugin.installed).toBe(false);
		expect(plugin.staleCache).toBe(true);
		expect(plugin.marketplace).toBe("claudekit");
		expect(plugin.version).toBe("87a174162601");
	});

	test("legacy + orphaned plugin cache classifies as legacy (matches claude plugin list)", async () => {
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
		await makePluginCache("claudekit", "87a174162601");
		const report = detectInstallMode(claudeDir);
		expect(report.mode).toBe("legacy");
		expect(report.plugin.installed).toBe(false);
		expect(report.plugin.staleCache).toBe(true);
	});

	test("registered plugin with cache is installed, not stale", async () => {
		await writeSettings({ "ck@claudekit": true });
		await makePluginCache("claudekit", "87a174162601");
		const plugin = detectPluginState(claudeDir);
		expect(plugin.installed).toBe(true);
		expect(plugin.staleCache).toBe(false);
		expect(plugin.version).toBe("87a174162601");
	});

	test("registered plugin cache prefers highest semver over newer stale mtime", async () => {
		await writeSettings({ "ck@claudekit": true });
		await makePluginCache("claudekit", "2.20.1-beta.5");
		await makePluginCache("claudekit", "2.20.1-beta.7");
		const ckDir = join(claudeDir, "plugins", "cache", "claudekit", "ck");
		await utimes(join(ckDir, "2.20.1-beta.7"), new Date(1_000), new Date(1_000));
		await utimes(join(ckDir, "2.20.1-beta.5"), new Date(2_000), new Date(2_000));

		expect(detectPluginState(claudeDir).version).toBe("2.20.1-beta.7");
		expect(resolveInstalledPluginCacheRoot(claudeDir)).toBe(join(ckDir, "2.20.1-beta.7"));
	});

	test("plugin cache uses mtime fallback for non-semver cache names", async () => {
		await writeSettings({ "ck@claudekit": true });
		await makePluginCache("claudekit", "aaa111");
		await makePluginCache("claudekit", "bbb222");
		const ckDir = join(claudeDir, "plugins", "cache", "claudekit", "ck");
		await utimes(join(ckDir, "bbb222"), new Date(1_000), new Date(1_000));
		await utimes(join(ckDir, "aaa111"), new Date(2_000), new Date(2_000));

		expect(detectPluginState(claudeDir).version).toBe("aaa111");
	});

	test("registered plugin cache root resolves only for an installed plugin", async () => {
		await writeSettings({ "ck@claudekit": true });
		await makePluginCache("claudekit", "87a174162601");
		await mkdir(join(claudeDir, "plugins", "cache", "claudekit", "ck", "87a174162601", "agents"), {
			recursive: true,
		});

		expect(resolveInstalledPluginCacheRoot(claudeDir)).toBe(
			join(claudeDir, "plugins", "cache", "claudekit", "ck", "87a174162601"),
		);
		expect(resolveInstalledPluginCacheSubpath("agents", claudeDir)).toBe(
			join(claudeDir, "plugins", "cache", "claudekit", "ck", "87a174162601", "agents"),
		);
	});

	test("orphaned plugin cache is not used as a source root", async () => {
		await makePluginCache("claudekit", "87a174162601");
		expect(resolveInstalledPluginCacheRoot(claudeDir)).toBeNull();
		expect(resolveInstalledPluginCacheSubpath("agents", claudeDir)).toBeNull();
	});

	test("plugin: unrelated plugins do not count as ck", async () => {
		await writeSettings({ "kai@kai-personal-claude": true, "ak-core@agentkit-local": true });
		expect(detectPluginState(claudeDir).installed).toBe(false);
		expect(detectInstallMode(claudeDir).mode).toBe("fresh");
	});

	test("plugin: ck from an unrelated marketplace is not ClaudeKit-owned state", async () => {
		await writeSettings({ "ck@community": true });
		await makePluginCache("community", "9.9.9");

		expect(detectPluginState(claudeDir)).toEqual({
			installed: false,
			enabled: false,
			version: null,
			marketplace: null,
			staleCache: false,
		});
		expect(detectInstallMode(claudeDir).mode).toBe("fresh");
		expect(resolveInstalledPluginCacheRoot(claudeDir)).toBeNull();
	});

	test("plugin: unrelated ck cache does not mask the official ClaudeKit cache", async () => {
		await writeSettings({ "ck@community": true, "ck@claudekit": true });
		await makePluginCache("community", "9.9.9");
		await makePluginCache("claudekit", "2.20.1");

		expect(detectPluginState(claudeDir)).toEqual({
			installed: true,
			enabled: true,
			version: "2.20.1",
			marketplace: "claudekit",
			staleCache: false,
		});
	});

	test("mixed: legacy payload AND plugin registration present", async () => {
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
		await makePluginCache("claudekit", "abc123def456");
		const report = detectInstallMode(claudeDir);
		expect(report.mode).toBe("mixed");
		expect(report.plugin.installed).toBe(true);
		expect(report.legacy.installed).toBe(true);
	});

	test("mixed: metadata-free legacy files match a historical CK plugin cache payload", async () => {
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
		await writePluginCacheFile("2.20.1-beta.5", "skills/gemini-research/SKILL.md", "retired\n");
		await writePluginCacheFile("2.20.1-beta.7", "skills/cook/SKILL.md", "current\n");
		await mkdir(join(claudeDir, "skills", "gemini-research"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "gemini-research", "SKILL.md"), "retired\n", "utf-8");

		const report = detectInstallMode(claudeDir);

		expect(report.mode).toBe("mixed");
		expect(report.legacy).toEqual({ installed: true, version: "2.20.1-beta.7" });
		expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(true);
	});

	test.each([
		["absent", null],
		["malformed", "{"],
		["empty", {}],
		["unrecognized", { unrelated: true }],
	] as const)(
		"mixed: %s metadata retains official cache ownership proof",
		async (_label, metadata) => {
			await writeSettings({ "ck@claudekit": true });
			if (metadata === "{") {
				await writeFile(join(claudeDir, "metadata.json"), metadata, "utf-8");
			} else if (metadata !== null) {
				await writeMetadata(metadata);
			}
			await writePluginCacheFile("2.20.1-beta.5", "skills/retired/SKILL.md", "retired\n");
			await mkdir(join(claudeDir, "skills", "retired"), { recursive: true });
			await writeFile(join(claudeDir, "skills", "retired", "SKILL.md"), "retired\n", "utf-8");

			expect(detectInstallMode(claudeDir).mode).toBe("mixed");
			expect(detectLegacyState(claudeDir)).toEqual({ installed: true, version: null });
		},
	);

	test.each([
		["missing", null],
		["forged name", { name: "other", version: "2.20.1-beta.5" }],
		["version mismatch", { name: "ck", version: "2.20.1-beta.4" }],
		["malformed", "{"],
	] as const)(
		"plugin: %s cache manifest cannot prove orphan ownership",
		async (_label, manifest) => {
			const version = "2.20.1-beta.5";
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
			await writePluginCachePayloadWithoutManifest(version, "skills/retired/SKILL.md", "retired\n");
			if (manifest !== null) await writePluginCacheManifest(version, manifest);
			await mkdir(join(claudeDir, "skills", "retired"), { recursive: true });
			await writeFile(join(claudeDir, "skills", "retired", "SKILL.md"), "retired\n", "utf-8");

			expect(detectInstallMode(claudeDir).mode).toBe("plugin");
			expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(false);
		},
	);

	test("mixed: cache manifest and directory versions may differ only by leading v", async () => {
		await writeSettings({ "ck@claudekit": true });
		await writePluginCachePayloadWithoutManifest(
			"v2.20.1-beta.5",
			"skills/retired/SKILL.md",
			"retired\n",
		);
		await writePluginCacheManifest("v2.20.1-beta.5", {
			name: "ck",
			version: "2.20.1-beta.5",
		});
		await mkdir(join(claudeDir, "skills", "retired"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "retired", "SKILL.md"), "retired\n", "utf-8");

		expect(detectInstallMode(claudeDir).mode).toBe("mixed");
	});

	test.skipIf(process.platform === "win32")(
		"plugin: symlinked CK manifest cannot prove orphan ownership",
		async () => {
			const version = "2.20.1-beta.5";
			const outsideManifest = join(claudeDir, "outside-plugin.json");
			const manifestPath = join(
				claudeDir,
				"plugins",
				"cache",
				"claudekit",
				"ck",
				version,
				".claude-plugin",
				"plugin.json",
			);
			await writeSettings({ "ck@claudekit": true });
			await writePluginCachePayloadWithoutManifest(version, "skills/retired/SKILL.md", "retired\n");
			await mkdir(dirname(manifestPath), { recursive: true });
			await writeFile(outsideManifest, JSON.stringify({ name: "ck", version }), "utf-8");
			await symlink(outsideManifest, manifestPath, "file");
			await mkdir(join(claudeDir, "skills", "retired"), { recursive: true });
			await writeFile(join(claudeDir, "skills", "retired", "SKILL.md"), "retired\n", "utf-8");

			expect(detectInstallMode(claudeDir).mode).toBe("plugin");
			expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(false);
		},
	);

	test("plugin: modified, custom, and symlinked legacy files are not cache-owned", async () => {
		const outsideDir = join(
			tmpdir(),
			`ck-mode-outside-${Date.now()}-${Math.round(performance.now())}`,
		);
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
		await writePluginCacheFile("2.20.1-beta.5", "skills/cook/SKILL.md", "original\n");
		await writePluginCacheFile("2.20.1-beta.5", "skills/linked/SKILL.md", "outside\n");
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "edited\n", "utf-8");
		await mkdir(join(claudeDir, "skills", "custom"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "custom", "SKILL.md"), "custom\n", "utf-8");
		await mkdir(outsideDir, { recursive: true });
		await writeFile(join(outsideDir, "SKILL.md"), "outside\n", "utf-8");
		await symlink(outsideDir, join(claudeDir, "skills", "linked"), "dir");
		await mkdir(join(claudeDir, "skills", "cache-linked"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cache-linked", "SKILL.md"), "outside\n", "utf-8");
		await symlink(
			outsideDir,
			join(
				claudeDir,
				"plugins",
				"cache",
				"claudekit",
				"ck",
				"2.20.1-beta.5",
				"skills",
				"cache-linked",
			),
			"dir",
		);

		try {
			expect(detectInstallMode(claudeDir).mode).toBe("plugin");
			expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(false);
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	test("plugin migration receipt metadata without legacy payload does not stay mixed forever", async () => {
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

		const report = detectInstallMode(claudeDir);
		expect(report.mode).toBe("plugin");
		expect(report.plugin.installed).toBe(true);
		expect(report.legacy.installed).toBe(false);
	});

	test("detects tracked legacy agent/skill payloads that still need plugin cleanup", async () => {
		await mkdir(join(claudeDir, "agents"), { recursive: true });
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "agents", "planner.md"), "# planner\n", "utf-8");
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "# cook\n", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [
						{ path: "agents/planner.md", ownership: "ck" },
						{ path: "skills/cook/SKILL.md", ownership: "ck-modified" },
						{ path: "agents/user.md", ownership: "user" },
					],
				},
			},
		});

		expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(true);
	});

	test("detects unmodified user-owned plugin payloads from manifestless installs", async () => {
		const skillContent = "# cook\n";
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), skillContent, "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "local",
					files: [
						{
							path: "skills/cook/SKILL.md",
							ownership: "user",
							checksum: sha256(skillContent),
						},
					],
				},
			},
		});

		expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(true);
	});

	test("ignores modified user-owned plugin payloads from manifestless installs", async () => {
		await mkdir(join(claudeDir, "skills", "cook"), { recursive: true });
		await writeFile(join(claudeDir, "skills", "cook", "SKILL.md"), "# edited\n", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "local",
					files: [
						{
							path: "skills/cook/SKILL.md",
							ownership: "user",
							checksum: sha256("# original\n"),
						},
					],
				},
			},
		});

		expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(false);
	});

	test("ignores unsafe tracked plugin payload paths", async () => {
		await writeFile(join(claudeDir, "settings.json"), "settings", "utf-8");
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "skills/../settings.json", ownership: "ck" }],
				},
			},
		});

		expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(false);
	});

	test("ignores mixed installs after plugin-supplied legacy files are gone", async () => {
		await writeMetadata({
			kits: {
				engineer: {
					version: "2.19.0",
					files: [{ path: "hooks/session-init.cjs", ownership: "ck" }],
				},
			},
		});

		expect(hasTrackedPluginSuppliedLegacyFiles(claudeDir)).toBe(false);
	});

	test("classifyInstallMode covers all four quadrants", () => {
		const P = (installed: boolean) => ({
			installed,
			enabled: installed,
			version: null,
			marketplace: null,
			staleCache: false,
		});
		const L = (installed: boolean) => ({ installed, version: null });
		expect(classifyInstallMode(P(false), L(false))).toBe("fresh");
		expect(classifyInstallMode(P(false), L(true))).toBe("legacy");
		expect(classifyInstallMode(P(true), L(false))).toBe("plugin");
		expect(classifyInstallMode(P(true), L(true))).toBe("mixed");
	});

	test("malformed settings/metadata are treated as absent (no throw)", async () => {
		await writeFile(join(claudeDir, "settings.json"), "{ not json", "utf-8");
		await writeFile(join(claudeDir, "metadata.json"), "also not json", "utf-8");
		expect(() => detectInstallMode(claudeDir)).not.toThrow();
		expect(detectInstallMode(claudeDir).mode).toBe("fresh");
	});
});
