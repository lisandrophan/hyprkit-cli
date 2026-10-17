/**
 * End-to-end init against a local kit (--kit-path), covering two regressions:
 * - `--dry-run` installed the whole kit unless `--prefix` was also passed
 * - an existing, user-written AGENTS.md at the project root was replaced by the kit's
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { initCommand } from "@/commands/init/init-command.js";
import { FileMerger } from "@/domains/installation/file-merger.js";
import type { UpdateCommandOptions } from "@/types";

const USER_AGENTS_MD = "# longpc.dev\n\nProject docs and writing rules, written by hand.\n";
const KIT_AGENTS_MD = "Name: hyprkit\nGeneric kit template for OpenCode.\n";

const originalTestHome = process.env.HK_TEST_HOME;

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
}

/** Every file under `root` mapped to its content. */
async function snapshot(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const fullPath = join(entry.parentPath, entry.name);
		result[relative(root, fullPath)] = await readFile(fullPath, "utf8");
	}
	return result;
}

describe("init --dry-run and project-root file protection", () => {
	let tempDir: string;
	let testHome: string;
	let kitDir: string;
	let projectDir: string;

	const runInit = (overrides: Partial<UpdateCommandOptions> = {}) =>
		initCommand({
			kit: "hyprkit",
			dir: projectDir,
			kitPath: kitDir,
			yes: true,
			skipSetup: true,
			...overrides,
		} as UpdateCommandOptions);

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hk-init-dry-run-"));
		testHome = join(tempDir, "home");
		kitDir = join(tempDir, "kit");
		projectDir = join(tempDir, "project");
		process.env.HK_TEST_HOME = testHome;

		await mkdir(join(testHome, ".claude"), { recursive: true });
		await writeFiles(kitDir, {
			"AGENTS.md": KIT_AGENTS_MD,
			"CLAUDE.md": "AGENTS.md\n",
			".claude/rules/development-rules.md": "# Development Rules\n",
			".claude/settings.json": JSON.stringify({ hooks: {} }),
		});
		await writeFiles(projectDir, {
			"AGENTS.md": USER_AGENTS_MD,
			"package.json": '{ "name": "site" }\n',
			".claude/rules/my-own-rule.md": "mine\n",
		});
	});

	afterEach(async () => {
		if (originalTestHome === undefined) {
			Reflect.deleteProperty(process.env, "HK_TEST_HOME");
		} else {
			process.env.HK_TEST_HOME = originalTestHome;
		}
		process.exitCode = 0;
		await rm(tempDir, { recursive: true, force: true });
	});

	test("--dry-run writes nothing to the project or the global kit dir", async () => {
		const projectBefore = await snapshot(projectDir);
		const globalBefore = await snapshot(join(testHome, ".claude"));

		await runInit({ dryRun: true });

		expect(await snapshot(projectDir)).toEqual(projectBefore);
		expect(await snapshot(join(testHome, ".claude"))).toEqual(globalBefore);
	});

	test("--dry-run cannot be combined with --fresh", async () => {
		await expect(runInit({ dryRun: true, fresh: true })).rejects.toThrow(
			"--dry-run cannot be combined with --fresh",
		);
		expect(await readFile(join(projectDir, "AGENTS.md"), "utf8")).toBe(USER_AGENTS_MD);
	});

	test("init keeps an existing AGENTS.md and still installs the rest of the kit", async () => {
		await runInit();

		expect(await readFile(join(projectDir, "AGENTS.md"), "utf8")).toBe(USER_AGENTS_MD);
		// Root files the user did not have are installed as usual.
		expect(await readFile(join(projectDir, "CLAUDE.md"), "utf8")).toBe("AGENTS.md\n");
		expect(await readFile(join(projectDir, ".claude/rules/development-rules.md"), "utf8")).toBe(
			"# Development Rules\n",
		);
		expect(await readFile(join(projectDir, ".claude/rules/my-own-rule.md"), "utf8")).toBe("mine\n");
	});

	test("init --force-overwrite replaces an existing AGENTS.md", async () => {
		await runInit({ forceOverwrite: true });

		expect(await readFile(join(projectDir, "AGENTS.md"), "utf8")).toBe(KIT_AGENTS_MD);
	});
});

describe("FileMerger root-file protection", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hk-root-files-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("keeps differing root files, leaves settings.json to its own merge, updates nested files", async () => {
		const source = join(tempDir, "source");
		const dest = join(tempDir, "dest");
		await writeFiles(source, {
			"AGENTS.md": KIT_AGENTS_MD,
			"settings.json": JSON.stringify({ env: { FROM_KIT: "1" } }),
			"rules/rule.md": "new\n",
		});
		await writeFiles(dest, {
			"AGENTS.md": USER_AGENTS_MD,
			"settings.json": JSON.stringify({ env: { FROM_USER: "1" } }),
			"rules/rule.md": "old\n",
		});

		const merger = new FileMerger();
		merger.setProtectRootFiles(true);
		await merger.merge(source, dest, true);

		expect(await readFile(join(dest, "AGENTS.md"), "utf8")).toBe(USER_AGENTS_MD);
		// settings.json goes through its own selective merge, not the root-file rule.
		expect(merger.getProtectedRootFiles()).toEqual(["AGENTS.md"]);
		expect(await readFile(join(dest, "rules/rule.md"), "utf8")).toBe("new\n");
	});
});
