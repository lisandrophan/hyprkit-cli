import { describe, expect, test } from "bun:test";
import { collectEngineerHistoricalFiles } from "@/domains/installation/plugin/historical-metadata-files.js";

describe("collectEngineerHistoricalFiles", () => {
	test("uses only nested Engineer records when multiple kits exist", () => {
		const result = collectEngineerHistoricalFiles({
			files: [
				{ path: "skills/root-only/SKILL.md", ownership: "ck" },
				{ path: "skills/shared/SKILL.md", ownership: "user" },
			],
			installedFiles: ["agents/root-agent.md", "skills/shared/SKILL.md"],
			kits: {
				engineer: {
					files: [
						{ path: "skills/shared/SKILL.md", ownership: "ck" },
						{ path: "skills/nested-only/SKILL.md", ownership: "ck-modified" },
					],
					installedFiles: ["agents/nested-agent.md", "agents/root-agent.md"],
				},
				marketing: {
					files: [{ path: "skills/marketing/SKILL.md", ownership: "ck" }],
					installedFiles: ["agents/marketing.md"],
				},
			},
		});

		expect(result).toEqual([
			{ path: "skills/shared/SKILL.md", ownership: "ck" },
			{ path: "skills/nested-only/SKILL.md", ownership: "ck-modified" },
			{ path: "agents/nested-agent.md", ownership: "unknown" },
			{ path: "agents/root-agent.md", ownership: "unknown" },
		]);
	});

	test("merges transitional root records only when Engineer is the sole kit", () => {
		const result = collectEngineerHistoricalFiles({
			files: [
				{ path: "skills/root-only/SKILL.md", ownership: "ck" },
				{ path: "skills/shared/SKILL.md", ownership: "user" },
			],
			installedFiles: ["agents/root-agent.md"],
			kits: {
				engineer: {
					files: [{ path: "skills/shared/SKILL.md", ownership: "ck" }],
				},
			},
		});

		expect(result).toEqual([
			{ path: "skills/shared/SKILL.md", ownership: "ck" },
			{ path: "skills/root-only/SKILL.md", ownership: "ck" },
			{ path: "agents/root-agent.md", ownership: "unknown" },
		]);
	});

	test("does not attribute transitional root records to Engineer when only another kit exists", () => {
		const result = collectEngineerHistoricalFiles({
			files: [{ path: "skills/marketing/SKILL.md", ownership: "ck" }],
			installedFiles: ["agents/marketing.md"],
			kits: {
				marketing: {
					files: [{ path: "skills/marketing/SKILL.md", ownership: "ck" }],
				},
			},
		});

		expect(result).toEqual([]);
	});
});
