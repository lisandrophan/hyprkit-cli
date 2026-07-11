import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKILL_NAME_PREFIX = "ck:";
const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const FRONTMATTER = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const NAME_LINE = /^([ \t]*name[ \t]*:[ \t]*)(.*)$/gm;

export interface EngineerLegacySkillProjectionResult {
	skillsScanned: number;
	skillsProjected: number;
}

export interface EngineerSkillProjectionContext {
	kitType?: string;
	installMode: string;
}

interface Projection {
	content: string;
	name?: string;
	changed: boolean;
}

function projectNameValue(
	rawValue: string,
): { value: string; name: string; changed: boolean } | null {
	const valueMatch = rawValue.match(
		/^([ \t]*)(?:(["'])([a-zA-Z0-9][a-zA-Z0-9._:-]*)\2|([a-zA-Z0-9][a-zA-Z0-9._:-]*))([ \t]*(?:#.*)?)$/,
	);
	if (!valueMatch) return null;

	const [, leadingWhitespace, quote = "", quotedName, plainName, suffix] = valueMatch;
	const name = quotedName ?? plainName;
	if (!name || !SAFE_SKILL_NAME.test(name)) return null;

	const projectedName = name.startsWith(SKILL_NAME_PREFIX) ? name : `${SKILL_NAME_PREFIX}${name}`;

	return {
		value: `${leadingWhitespace}${quote}${projectedName}${quote}${suffix}`,
		name: projectedName,
		changed: projectedName !== name,
	};
}

/**
 * Project a canonical Engineer skill name onto a Normal-install destination copy.
 *
 * The replacement is intentionally surgical: only a single scalar `name:` field
 * in valid leading YAML frontmatter is changed. All other bytes remain intact.
 */
export function projectEngineerLegacySkillContent(content: string): Projection {
	const frontmatterMatch = content.match(FRONTMATTER);
	if (!frontmatterMatch) return { content, changed: false };

	const frontmatterBody = frontmatterMatch[2];
	const nameLines = [...frontmatterBody.matchAll(NAME_LINE)];
	if (nameLines.length !== 1) return { content, changed: false };

	const nameLine = nameLines[0];
	const projected = projectNameValue(nameLine[2]);
	if (!projected) return { content, changed: false };

	const lineStart = nameLine.index ?? 0;
	const valueStart = lineStart + nameLine[1].length;
	const projectedFrontmatter =
		frontmatterBody.slice(0, valueStart) +
		projected.value +
		frontmatterBody.slice(valueStart + nameLine[2].length);

	return {
		content:
			frontmatterMatch[1] +
			projectedFrontmatter +
			frontmatterMatch[3] +
			content.slice(frontmatterMatch[0].length),
		name: projected.name,
		changed: projected.changed,
	};
}

/**
 * Rewrite only the temporary Engineer payload used by legacy/Normal installs.
 * Symlinked skill directories and files are skipped to keep traversal bounded.
 */
async function projectEngineerLegacySkillNames(
	extractDir: string,
): Promise<EngineerLegacySkillProjectionResult> {
	const skillsDir = join(extractDir, ".claude", "skills");
	let skillFiles: string[];
	try {
		skillFiles = await collectSkillFiles(skillsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { skillsScanned: 0, skillsProjected: 0 };
		}
		throw error;
	}

	const projections: Array<{ filePath: string; projection: Projection }> = [];
	const projectedNames = new Map<string, string>();
	let skillsScanned = 0;

	for (const filePath of skillFiles) {
		let fileStats;
		try {
			fileStats = await lstat(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!fileStats.isFile() || fileStats.isSymbolicLink()) continue;

		skillsScanned += 1;
		const projection = projectEngineerLegacySkillContent(await readFile(filePath, "utf8"));
		if (projection.name) {
			const previousPath = projectedNames.get(projection.name);
			if (previousPath) {
				throw new Error(
					`Engineer skill name collision after Normal-install projection: ${projection.name} (${previousPath}, ${filePath})`,
				);
			}
			projectedNames.set(projection.name, filePath);
		}
		if (projection.changed) projections.push({ filePath, projection });
	}

	for (const { filePath, projection } of projections) {
		await writeFile(filePath, projection.content, "utf8");
	}

	return { skillsScanned, skillsProjected: projections.length };
}

async function collectSkillFiles(directory: string): Promise<string[]> {
	const entries: Dirent<string>[] = await readdir(directory, { withFileTypes: true });
	const skillFiles: string[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.isSymbolicLink()) continue;
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			skillFiles.push(...(await collectSkillFiles(entryPath)));
		} else if (entry.isFile() && entry.name === "SKILL.md") {
			skillFiles.push(entryPath);
		}
	}
	return skillFiles;
}

/**
 * Apply the compatibility projection only for Engineer Normal installations.
 * Plugin staging and other kits return before reading or writing the payload.
 */
export async function projectEngineerSkillNamesForInstall(
	extractDir: string,
	context: EngineerSkillProjectionContext,
): Promise<EngineerLegacySkillProjectionResult> {
	if (context.kitType !== "engineer" || context.installMode === "plugin") {
		return { skillsScanned: 0, skillsProjected: 0 };
	}

	return projectEngineerLegacySkillNames(extractDir);
}
