import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "@/domains/migration/release-manifest.js";
import { buildFileTrackingList } from "@/services/file-operations/manifest/manifest-tracker.js";

const SHIPPED = "a".repeat(64);

const manifest: ReleaseManifest = {
	version: "0.1.0",
	generatedAt: "2026-09-06T00:00:00.000Z",
	files: [
		{
			path: "rules/development-rules.md",
			checksum: SHIPPED,
			size: 10,
			lastModified: "2026-09-06T11:38:50+07:00",
		},
	],
};

describe("buildFileTrackingList locally-modified handling", () => {
	let claudeDir: string;

	beforeEach(() => {
		claudeDir = mkdtempSync(join(tmpdir(), "locally-modified-"));
		writeFileSync(join(claudeDir, "placeholder"), "x");
	});

	afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

	const build = (locallyModified?: Map<string, string>) =>
		buildFileTrackingList({
			installedFiles: [".claude/rules/development-rules.md"],
			claudeDir,
			releaseManifest: manifest,
			installedVersion: "v0.1.0",
			isGlobal: false,
			locallyModified,
		});

	it("records an untouched kit file as ck", () => {
		const [entry] = build();
		expect(entry.ownership).toBe("ck");
		expect(entry.relativePath).toBe("rules/development-rules.md");
		// No explicit checksum: the tracker hashes the file on disk.
		expect(entry.checksum).toBeUndefined();
	});

	it("carries the manifest timestamp through, which the prefixed lookup used to lose", () => {
		expect(build()[0].sourceTimestamp).toBe("2026-09-06T11:38:50+07:00");
	});

	it("records a held-back file as ck-modified against the shipped checksum", () => {
		// Recording the on-disk checksum instead would make the edited content the new
		// baseline, so the next update would see no difference and overwrite it.
		const [entry] = build(new Map([["rules/development-rules.md", SHIPPED]]));
		expect(entry.ownership).toBe("ck-modified");
		expect(entry.checksum).toBe(SHIPPED);
	});

	it("accepts the held-back key in its prefixed form too", () => {
		const [entry] = build(new Map([[".claude/rules/development-rules.md", SHIPPED]]));
		expect(entry.ownership).toBe("ck-modified");
		expect(entry.checksum).toBe(SHIPPED);
	});
});
