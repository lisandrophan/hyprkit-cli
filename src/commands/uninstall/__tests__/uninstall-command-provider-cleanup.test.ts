import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineerProviderCleanupResult } from "@/domains/installation/plugin/engineer-provider-cleanup.js";
import { logger } from "@/shared/logger.js";
import { type TestPaths, setupTestPaths } from "../../../../tests/helpers/test-paths.js";
import { uninstallCommand } from "../uninstall-command.js";

const cleanProviders: EngineerProviderCleanupResult = {
	success: true,
	changed: true,
	claude: null,
	codex: null,
	errors: [],
};

describe("uninstallCommand provider cleanup", () => {
	let paths: TestPaths;
	let projectDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		paths = setupTestPaths();
		projectDir = join(paths.testHome, "project");
		await mkdir(join(projectDir, ".claude"), { recursive: true });
		process.chdir(projectDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		paths.cleanup();
	});

	async function install(scope: "global" | "local", kit: "engineer" | "marketing") {
		const claudeDir = scope === "global" ? paths.claudeDir : join(projectDir, ".claude");
		await mkdir(join(claudeDir, "skills"), { recursive: true });
		await writeFile(join(claudeDir, "skills", `${kit}.md`), kit);
		await writeFile(
			join(claudeDir, "metadata.json"),
			JSON.stringify({
				name: kit,
				version: "1.0.0",
				installedAt: "2026-07-11T00:00:00.000Z",
				scope,
				installedFiles: [`skills/${kit}.md`],
			}),
		);
	}

	function options(overrides: Record<string, unknown> = {}) {
		return {
			yes: true,
			json: false,
			verbose: false,
			local: false,
			global: false,
			all: false,
			dryRun: false,
			forceOverwrite: true,
			...overrides,
		};
	}

	test("global Engineer uninstall cleans both provider plugins", async () => {
		await install("global", "engineer");
		let cleanupCalls = 0;

		await uninstallCommand(options({ global: true }), {
			cleanupEngineerProviderPlugins: async () => {
				cleanupCalls += 1;
				return cleanProviders;
			},
		});

		expect(cleanupCalls).toBe(1);
	});

	test("all-scope uninstall cleans providers once", async () => {
		await install("global", "engineer");
		await install("local", "engineer");
		let cleanupCalls = 0;

		await uninstallCommand(options({ all: true }), {
			cleanupEngineerProviderPlugins: async () => {
				cleanupCalls += 1;
				return cleanProviders;
			},
		});

		expect(cleanupCalls).toBe(1);
	});

	test("project-only uninstall preserves global provider state", async () => {
		await install("local", "engineer");
		let cleanupCalls = 0;

		await uninstallCommand(options({ local: true }), {
			cleanupEngineerProviderPlugins: async () => {
				cleanupCalls += 1;
				return cleanProviders;
			},
		});

		expect(cleanupCalls).toBe(0);
	});

	test("Marketing-only uninstall preserves Engineer provider state", async () => {
		await install("global", "marketing");
		let cleanupCalls = 0;

		await uninstallCommand(options({ global: true, kit: "marketing" }), {
			cleanupEngineerProviderPlugins: async () => {
				cleanupCalls += 1;
				return cleanProviders;
			},
		});

		expect(cleanupCalls).toBe(0);
	});

	test("verification failure prevents a successful command result", async () => {
		await install("global", "engineer");
		const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const errorSpy = spyOn(logger, "error").mockImplementation(() => {});

		await uninstallCommand(options({ global: true }), {
			cleanupEngineerProviderPlugins: async () => ({
				...cleanProviders,
				success: false,
				changed: false,
				errors: ["Codex plugin remains installed"],
			}),
		});

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Engineer plugin cleanup incomplete: Codex plugin remains installed",
		);
		expect(existsSync(join(paths.claudeDir, "skills", "engineer.md"))).toBe(true);
		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});

	test("repeated uninstall is idempotent", async () => {
		await install("global", "engineer");
		let cleanupCalls = 0;
		const deps = {
			cleanupEngineerProviderPlugins: async () => {
				cleanupCalls += 1;
				return cleanProviders;
			},
		};

		await uninstallCommand(options({ global: true }), deps);
		await uninstallCommand(options({ global: true }), deps);

		expect(cleanupCalls).toBe(2);
	});

	test("explicit global uninstall removes provider-only state without file metadata", async () => {
		let cleanupCalls = 0;
		await uninstallCommand(options({ global: true }), {
			cleanupEngineerProviderPlugins: async () => {
				cleanupCalls += 1;
				return cleanProviders;
			},
		});

		expect(cleanupCalls).toBe(1);
	});
});
