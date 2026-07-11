import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClaudeRunResult,
	type ClaudeRunner,
	PluginInstaller,
} from "@/domains/installation/plugin/plugin-installer.js";
import { uninstallEnginePlugin } from "@/domains/installation/plugin/uninstall-plugin.js";

function recordingInstaller(
	onCall?: (args: string[]) => Promise<ClaudeRunResult | undefined> | ClaudeRunResult | undefined,
) {
	const calls: string[][] = [];
	const runner: ClaudeRunner = async (args): Promise<ClaudeRunResult> => {
		calls.push(args);
		const result = await onCall?.(args);
		return result ?? { ok: true, stdout: "", stderr: "", code: 0 };
	};
	return { installer: new PluginInstaller(runner), calls };
}

describe("uninstallEnginePlugin", () => {
	let claudeDir: string;
	beforeEach(async () => {
		claudeDir = join(tmpdir(), `ck-unp-${Date.now()}-${Math.round(performance.now())}`);
		await mkdir(claudeDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(claudeDir, { recursive: true, force: true });
	});

	const cacheDir = () => join(claudeDir, "plugins", "cache", "claudekit", "ck");
	const registryPath = () => join(claudeDir, "plugins", "known_marketplaces.json");

	async function writeRegistry(registry: unknown): Promise<void> {
		await mkdir(join(claudeDir, "plugins"), { recursive: true });
		await writeFile(registryPath(), JSON.stringify(registry), "utf-8");
	}

	test("registered plugin: uninstalls, removes marketplace, purges cache", async () => {
		await writeFile(
			join(claudeDir, "settings.json"),
			JSON.stringify({ enabledPlugins: { "ck@claudekit": true } }),
			"utf-8",
		);
		await mkdir(join(cacheDir(), "v1"), { recursive: true });
		await writeRegistry({
			claudekit: { source: { source: "directory", path: "/tmp/claudekit" } },
		});
		const { installer, calls } = recordingInstaller(async (args) => {
			if (args.join(" ") === "plugin uninstall ck") {
				await writeFile(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: {} }));
			}
			if (args.join(" ") === "plugin marketplace remove claudekit") {
				await writeRegistry({});
			}
			return undefined;
		});

		const r = await uninstallEnginePlugin({ claudeDir, installer });

		expect(r.uninstalled).toBe(true);
		expect(r.staleCacheRemoved).toBe(true);
		expect(r.marketplaceRemoved).toBe(true);
		expect(r.pluginStillInstalled).toBe(false);
		expect(r.marketplaceStillRegistered).toBe(false);
		expect(r.error).toBeUndefined();
		expect(calls).toContainEqual(["plugin", "uninstall", "ck"]);
		expect(calls).toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
		expect(existsSync(cacheDir())).toBe(false);
	});

	test("nothing installed: no-op, no claude calls", async () => {
		const { installer, calls } = recordingInstaller();
		const r = await uninstallEnginePlugin({ claudeDir, installer });
		expect(r).toEqual({
			uninstalled: false,
			staleCacheRemoved: false,
			marketplaceRemoved: false,
			pluginStillInstalled: false,
			marketplaceStillRegistered: false,
			error: undefined,
		});
		expect(calls).toHaveLength(0);
	});

	test("orphaned stale cache only: purges cache, does NOT call uninstall", async () => {
		await mkdir(join(cacheDir(), "v1"), { recursive: true });
		const { installer, calls } = recordingInstaller();
		const r = await uninstallEnginePlugin({ claudeDir, installer });
		expect(r.uninstalled).toBe(false);
		expect(r.staleCacheRemoved).toBe(true);
		expect(r.pluginStillInstalled).toBe(false);
		expect(calls).toHaveLength(0); // not registered -> no uninstall command
		expect(existsSync(cacheDir())).toBe(false);
	});

	test("reports when the plugin remains registered after cleanup commands", async () => {
		await writeFile(
			join(claudeDir, "settings.json"),
			JSON.stringify({ enabledPlugins: { "ck@claudekit": true } }),
			"utf-8",
		);
		const { installer } = recordingInstaller();

		const r = await uninstallEnginePlugin({ claudeDir, installer });

		expect(r.uninstalled).toBe(true);
		expect(r.pluginStillInstalled).toBe(true);
		expect(r.error).toContain("plugin remains registered");
	});

	test("marketplace-only registry is removed while unrelated entries are preserved", async () => {
		const unrelated = { source: { source: "github", repo: "example/community" } };
		await writeRegistry({
			claudekit: { source: { source: "directory", path: "/tmp/claudekit" } },
			community: unrelated,
		});
		const { installer, calls } = recordingInstaller(async (args) => {
			if (args.join(" ") === "plugin marketplace remove claudekit") {
				await writeRegistry({ community: unrelated });
			}
			return undefined;
		});

		const result = await uninstallEnginePlugin({ claudeDir, installer });

		expect(result).toMatchObject({
			uninstalled: false,
			marketplaceRemoved: true,
			marketplaceStillRegistered: false,
			error: undefined,
		});
		expect(calls).toEqual([["plugin", "marketplace", "remove", "claudekit"]]);
		expect(JSON.parse(await readFile(registryPath(), "utf-8"))).toEqual({
			community: unrelated,
		});
	});

	test("nested marketplace-only registry shape is removed and verified", async () => {
		await writeRegistry({
			marketplaces: {
				claudekit: { installLocation: "/tmp/claudekit" },
				community: { installLocation: "/tmp/community" },
			},
		});
		const { installer } = recordingInstaller(async (args) => {
			if (args.join(" ") === "plugin marketplace remove claudekit") {
				await writeRegistry({
					marketplaces: { community: { installLocation: "/tmp/community" } },
				});
			}
			return undefined;
		});

		const result = await uninstallEnginePlugin({ claudeDir, installer });

		expect(result.marketplaceRemoved).toBe(true);
		expect(result.marketplaceStillRegistered).toBe(false);
		expect(result.error).toBeUndefined();
	});

	test("successful command with a remaining marketplace blocks cleanup success", async () => {
		await writeRegistry({ claudekit: { installLocation: "/tmp/claudekit" } });
		const { installer } = recordingInstaller();

		const result = await uninstallEnginePlugin({ claudeDir, installer });

		expect(result.marketplaceRemoved).toBe(true);
		expect(result.marketplaceStillRegistered).toBe(true);
		expect(result.error).toContain("marketplace remains registered");
	});

	test("failed marketplace removal with a registry remnant blocks cleanup success", async () => {
		await writeRegistry({ claudekit: { installLocation: "/tmp/claudekit" } });
		const { installer } = recordingInstaller((args) => {
			if (args.join(" ") === "plugin marketplace remove claudekit") {
				return { ok: false, stdout: "", stderr: "registry locked", code: 1 };
			}
			return undefined;
		});

		const result = await uninstallEnginePlugin({ claudeDir, installer });

		expect(result.marketplaceRemoved).toBe(false);
		expect(result.marketplaceStillRegistered).toBe(true);
		expect(result.error).toContain("marketplace remove failed: registry locked");
		expect(result.error).toContain("marketplace remains registered");
	});

	test("malformed marketplace registry cannot falsely verify cleanup", async () => {
		await mkdir(join(claudeDir, "plugins"), { recursive: true });
		await writeFile(registryPath(), "{not-json", "utf-8");
		const { installer, calls } = recordingInstaller();

		const result = await uninstallEnginePlugin({ claudeDir, installer });

		expect(calls).toEqual([["plugin", "marketplace", "remove", "claudekit"]]);
		expect(result.marketplaceStillRegistered).toBe(true);
		expect(result.error).toContain("marketplace absence cannot be verified");
	});

	test("already-absent marketplace is an idempotent no-op", async () => {
		await writeRegistry({ community: { installLocation: "/tmp/community" } });
		const { installer, calls } = recordingInstaller();

		const first = await uninstallEnginePlugin({ claudeDir, installer });
		const second = await uninstallEnginePlugin({ claudeDir, installer });

		expect(first).toMatchObject({
			marketplaceRemoved: false,
			marketplaceStillRegistered: false,
			error: undefined,
		});
		expect(second).toMatchObject(first);
		expect(calls).toHaveLength(0);
	});

	test("unrelated ck plugin and cache are preserved without provider calls", async () => {
		const settings = { enabledPlugins: { "ck@community": true } };
		const registry = { community: { installLocation: "/tmp/community" } };
		const communityCache = join(claudeDir, "plugins", "cache", "community", "ck", "9.9.9");
		await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings), "utf-8");
		await mkdir(communityCache, { recursive: true });
		await writeRegistry(registry);
		const { installer, calls } = recordingInstaller();

		const result = await uninstallEnginePlugin({ claudeDir, installer });

		expect(result).toEqual({
			uninstalled: false,
			staleCacheRemoved: false,
			marketplaceRemoved: false,
			pluginStillInstalled: false,
			marketplaceStillRegistered: false,
			error: undefined,
		});
		expect(calls).toHaveLength(0);
		expect(JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf-8"))).toEqual(settings);
		expect(JSON.parse(await readFile(registryPath(), "utf-8"))).toEqual(registry);
		expect(existsSync(communityCache)).toBe(true);
	});
});
