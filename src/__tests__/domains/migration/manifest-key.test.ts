import { describe, expect, it } from "bun:test";
import { ReleaseManifestLoader, toManifestKey } from "@/domains/migration/release-manifest.js";
import type { ReleaseManifest } from "@/domains/migration/release-manifest.js";

const manifest: ReleaseManifest = {
	version: "0.1.0",
	generatedAt: "2026-09-06T00:00:00.000Z",
	files: [
		{ path: "agents/planner.md", checksum: "a".repeat(64), size: 10 },
		{ path: "plans/templates/bug-fix-template.md", checksum: "b".repeat(64), size: 20 },
	],
};

describe("toManifestKey", () => {
	it("strips the .claude/ prefix, which is how manifests are keyed", () => {
		expect(toManifestKey(".claude/agents/planner.md")).toBe("agents/planner.md");
	});

	it("leaves paths outside .claude/ alone", () => {
		expect(toManifestKey("plans/templates/bug-fix-template.md")).toBe(
			"plans/templates/bug-fix-template.md",
		);
	});

	it("is idempotent, so double-normalising is harmless", () => {
		expect(toManifestKey(toManifestKey(".claude/agents/planner.md"))).toBe("agents/planner.md");
	});

	it("normalises backslashes so Windows paths match", () => {
		expect(toManifestKey(".claude\\agents\\planner.md")).toBe("agents/planner.md");
	});

	it("does not strip a directory that merely starts with .claude", () => {
		expect(toManifestKey(".claude-plugin/plugin.json")).toBe(".claude-plugin/plugin.json");
	});
});

describe("ReleaseManifestLoader.findFile", () => {
	// The bug this pins: callers pass install-relative paths that still carry the
	// `.claude/` prefix while manifests store them stripped. Every lookup missed, so
	// ownership came out "user" for the whole install and the merger re-copied files
	// it should have compared.
	it("finds an entry when the caller passes the prefixed path", () => {
		expect(ReleaseManifestLoader.findFile(manifest, ".claude/agents/planner.md")?.size).toBe(10);
	});

	it("finds the same entry when the caller passes the stripped path", () => {
		expect(ReleaseManifestLoader.findFile(manifest, "agents/planner.md")?.size).toBe(10);
	});

	it("still finds root-relative entries", () => {
		expect(
			ReleaseManifestLoader.findFile(manifest, "plans/templates/bug-fix-template.md")?.size,
		).toBe(20);
	});

	it("returns undefined for something not in the manifest", () => {
		expect(ReleaseManifestLoader.findFile(manifest, ".claude/agents/nope.md")).toBeUndefined();
	});
});
