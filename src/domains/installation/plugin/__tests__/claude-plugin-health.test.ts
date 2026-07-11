import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClaudePluginHealth } from "../claude-plugin-health.js";

describe("detectClaudePluginHealth", () => {
	let claudeDir: string;
	let expectedSource: string;

	beforeEach(async () => {
		claudeDir = await mkdtemp(join(tmpdir(), "ck-claude-health-"));
		expectedSource = join(claudeDir, "source");
		await mkdir(expectedSource, { recursive: true });
	});

	afterEach(async () => {
		await rm(claudeDir, { recursive: true, force: true });
	});

	async function register(
		options: {
			enabled?: boolean;
			version?: string;
			source?: string;
		} = {},
	): Promise<void> {
		await writeFile(
			join(claudeDir, "settings.json"),
			JSON.stringify({ enabledPlugins: { "ck@claudekit": options.enabled ?? true } }),
		);
		await mkdir(
			join(claudeDir, "plugins", "cache", "claudekit", "ck", options.version ?? "1.0.0"),
			{ recursive: true },
		);
		await mkdir(join(claudeDir, "plugins"), { recursive: true });
		await writeFile(
			join(claudeDir, "plugins", "known_marketplaces.json"),
			JSON.stringify({
				claudekit: {
					source: { source: "directory", path: options.source ?? expectedSource },
					installLocation: options.source ?? expectedSource,
				},
			}),
		);
	}

	test("reports missing registration", () => {
		expect(detectClaudePluginHealth(claudeDir).status).toBe("missing");
	});

	test("reports orphan cache", async () => {
		await mkdir(join(claudeDir, "plugins", "cache", "claudekit", "ck", "1.0.0"), {
			recursive: true,
		});
		expect(detectClaudePluginHealth(claudeDir).status).toBe("orphan-cache");
	});

	test("reports disabled registration", async () => {
		await register({ enabled: false });
		expect(detectClaudePluginHealth(claudeDir).status).toBe("disabled");
	});

	test("reports stale version", async () => {
		await register({ version: "1.0.0" });
		expect(
			detectClaudePluginHealth(claudeDir, { expectedVersion: "2.0.0", expectedSource }).status,
		).toBe("installed-stale-version");
	});

	test("reports stale source", async () => {
		await register({ source: join(claudeDir, "old-source") });
		expect(
			detectClaudePluginHealth(claudeDir, { expectedVersion: "1.0.0", expectedSource }).status,
		).toBe("installed-stale-source");
	});

	test("reports current state with normalized equivalent paths", async () => {
		await register({ source: join(expectedSource, "..", "source"), version: "v1.0.0" });
		const health = detectClaudePluginHealth(claudeDir, {
			expectedVersion: "1.0.0",
			expectedSource,
		});
		expect(health.status).toBe("installed-current");
		expect(health.shouldRefresh).toBe(false);
	});
});
