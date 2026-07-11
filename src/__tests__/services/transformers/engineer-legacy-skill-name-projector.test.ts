import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	projectEngineerLegacySkillContent,
	projectEngineerSkillNamesForInstall,
} from "@/services/transformers/engineer-legacy-skill-name-projector.js";

const tempDirs: string[] = [];

async function makePayload(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ck-legacy-skill-projection-"));
	tempDirs.push(root);
	return root;
}

async function writeSkill(root: string, directory: string, content: string): Promise<string> {
	const skillDir = join(root, ".claude", "skills", directory);
	await mkdir(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	await writeFile(filePath, content, "utf8");
	return filePath;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Engineer legacy skill name projection", () => {
	test("adds ck: exactly once while preserving all unrelated bytes", () => {
		const canonical = [
			"---",
			'name: "cook" # public command',
			"description: Keep: punctuation and formatting",
			"metadata:",
			"  version: 1",
			"---",
			"",
			"# Body",
			"Keep this body byte-for-byte.",
		].join("\r\n");

		const projected = projectEngineerLegacySkillContent(canonical);
		expect(projected.changed).toBe(true);
		expect(projected.name).toBe("ck:cook");
		expect(projected.content).toBe(canonical.replace('name: "cook"', 'name: "ck:cook"'));

		const repeated = projectEngineerLegacySkillContent(projected.content);
		expect(repeated.changed).toBe(false);
		expect(repeated.content).toBe(projected.content);
	});

	test.each([
		"---\nname: ck:cook\ndescription: Existing\n---\nBody\n",
		"# Missing frontmatter\nname: cook\n",
		"---\nname: [invalid\ndescription: Invalid\n---\nBody\n",
		"---\nname: first\nname: second\n---\nBody\n",
	])("leaves already-prefixed, missing, or invalid frontmatter unchanged", (content) => {
		const result = projectEngineerLegacySkillContent(content);
		expect(result.changed).toBe(false);
		expect(result.content).toBe(content);
	});

	test.each(["global", "local"])(
		"projects the temporary %s Normal-install payload without changing file shape",
		async () => {
			const root = await makePayload();
			const filePath = await writeSkill(
				root,
				"cook",
				"---\nname: cook\ndescription: Cook\n---\n\nBody\n",
			);

			const result = await projectEngineerSkillNamesForInstall(root, {
				kitType: "engineer",
				installMode: "legacy",
			});
			expect(result).toEqual({ skillsScanned: 1, skillsProjected: 1 });
			expect(await readFile(filePath, "utf8")).toContain("name: ck:cook");
		},
	);

	test("detects destination name collisions before writing any files", async () => {
		const root = await makePayload();
		const barePath = await writeSkill(root, "cook", "---\nname: cook\n---\nBody\n");
		await writeSkill(root, "cook-alias", "---\nname: ck:cook\n---\nAlias\n");

		await expect(
			projectEngineerSkillNamesForInstall(root, {
				kitType: "engineer",
				installMode: "legacy",
			}),
		).rejects.toThrow("name collision");
		expect(await readFile(barePath, "utf8")).toContain("name: cook\n");
	});

	test("projects nested Engineer skills and includes them in collision preflight", async () => {
		const root = await makePayload();
		const nestedPath = await writeSkill(
			root,
			"document-skills/pdf",
			"---\nname: pdf\ndescription: PDF\n---\nBody\n",
		);

		const result = await projectEngineerSkillNamesForInstall(root, {
			kitType: "engineer",
			installMode: "legacy",
		});

		expect(result).toEqual({ skillsScanned: 1, skillsProjected: 1 });
		expect(await readFile(nestedPath, "utf8")).toContain("name: ck:pdf");

		const aliasPath = await writeSkill(root, "pdf-alias", "---\nname: ck:pdf\n---\nAlias\n");
		await expect(
			projectEngineerSkillNamesForInstall(root, {
				kitType: "engineer",
				installMode: "legacy",
			}),
		).rejects.toThrow("name collision");
		expect(await readFile(aliasPath, "utf8")).toContain("name: ck:pdf");
	});

	test("skips symlinked skill entries to keep projection inside the payload", async () => {
		const root = await makePayload();
		const outsideRoot = await makePayload();
		const outsideFile = await writeSkill(outsideRoot, "outside", "---\nname: outside\n---\nBody\n");
		const skillsDir = join(root, ".claude", "skills");
		await mkdir(skillsDir, { recursive: true });
		await symlink(join(outsideRoot, ".claude", "skills", "outside"), join(skillsDir, "linked"));

		const result = await projectEngineerSkillNamesForInstall(root, {
			kitType: "engineer",
			installMode: "legacy",
		});
		expect(result).toEqual({ skillsScanned: 0, skillsProjected: 0 });
		expect(await readFile(outsideFile, "utf8")).toContain("name: outside\n");
	});

	test("missing skills directory is a deterministic no-op for plugin staging callers", async () => {
		const root = await makePayload();
		expect(
			await projectEngineerSkillNamesForInstall(root, {
				kitType: "engineer",
				installMode: "legacy",
			}),
		).toEqual({
			skillsScanned: 0,
			skillsProjected: 0,
		});
	});

	test.each([
		{ kitType: "engineer", installMode: "plugin" },
		{ kitType: "marketing", installMode: "legacy" },
	])("leaves $kitType $installMode staging byte-for-byte unchanged", async (context) => {
		const root = await makePayload();
		const canonical = "---\nname: cook\ndescription: Canonical\n---\nBody\n";
		const filePath = await writeSkill(root, "cook", canonical);

		expect(await projectEngineerSkillNamesForInstall(root, context)).toEqual({
			skillsScanned: 0,
			skillsProjected: 0,
		});
		expect(await readFile(filePath, "utf8")).toBe(canonical);
	});
});
