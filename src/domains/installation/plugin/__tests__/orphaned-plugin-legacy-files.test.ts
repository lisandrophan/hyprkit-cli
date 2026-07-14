import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultLegacyRemover } from "@/domains/installation/plugin/migrate-legacy-to-plugin.js";
import {
	collectOrphanedPluginLegacyFileProofs,
	orphanedPluginLegacyFileProofMatches,
} from "@/domains/installation/plugin/orphaned-plugin-legacy-files.js";

describe("orphaned plugin legacy file proofs", () => {
	const version = "2.20.1-beta.5";
	const relativePath = "skills/retired/SKILL.md";
	let root: string;
	let claudeDir: string;
	let cachePath: string;
	let manifestPath: string;
	let targetPath: string;
	let backupDir: string;
	let metadataPath: string;
	let metadataBytes: Buffer;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "ck-orphan-proof-"));
		claudeDir = join(root, "claude");
		const versionRoot = join(claudeDir, "plugins", "cache", "claudekit", "ck", version);
		cachePath = join(versionRoot, relativePath);
		manifestPath = join(versionRoot, ".claude-plugin", "plugin.json");
		targetPath = join(claudeDir, relativePath);
		backupDir = join(claudeDir, "backups", "proof-test");
		metadataPath = join(claudeDir, "metadata.json");
		await mkdir(dirname(cachePath), { recursive: true });
		await mkdir(dirname(manifestPath), { recursive: true });
		await mkdir(dirname(targetPath), { recursive: true });
		await mkdir(backupDir, { recursive: true });
		await writeFile(cachePath, "official\n");
		await writeFile(targetPath, "official\n");
		await writeFile(manifestPath, JSON.stringify({ name: "ck", version }));
		metadataBytes = Buffer.from('{"marker":"preserve"}\n');
		await writeFile(metadataPath, metadataBytes);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function collectSingleProof() {
		const proofs = collectOrphanedPluginLegacyFileProofs(claudeDir);
		expect(proofs).toHaveLength(1);
		return proofs[0];
	}

	function expectRemovalPreservedTarget(): void {
		expect(defaultLegacyRemover(claudeDir, backupDir)).toEqual([]);
		expect(existsSync(targetPath)).toBe(true);
		expect(existsSync(join(backupDir, relativePath))).toBe(false);
		expect(Buffer.compare(readFileSync(metadataPath), metadataBytes)).toBe(0);
	}

	test("target mutation invalidates a collected proof and prevents cleanup", async () => {
		const proof = collectSingleProof();

		await writeFile(targetPath, "user edit\n");

		expect(orphanedPluginLegacyFileProofMatches(claudeDir, proof)).toBe(false);
		expectRemovalPreservedTarget();
		expect(readFileSync(targetPath, "utf-8")).toBe("user edit\n");
	});

	test("cache mutation invalidates a collected proof and prevents cleanup", async () => {
		const proof = collectSingleProof();

		await writeFile(cachePath, "cache changed\n");

		expect(orphanedPluginLegacyFileProofMatches(claudeDir, proof)).toBe(false);
		expectRemovalPreservedTarget();
		expect(readFileSync(targetPath, "utf-8")).toBe("official\n");
	});

	test("manifest mutation invalidates a collected proof and prevents cleanup", async () => {
		const proof = collectSingleProof();

		await writeFile(manifestPath, JSON.stringify({ name: "forged", version }));

		expect(orphanedPluginLegacyFileProofMatches(claudeDir, proof)).toBe(false);
		expectRemovalPreservedTarget();
		expect(readFileSync(targetPath, "utf-8")).toBe("official\n");
	});

	test.skipIf(process.platform === "win32")(
		"target symlink replacement invalidates proof without touching its referent",
		async () => {
			const proof = collectSingleProof();
			const outsideTarget = join(root, "outside-target.md");
			await writeFile(outsideTarget, "official\n");
			await rm(targetPath);
			await symlink(outsideTarget, targetPath, "file");

			expect(orphanedPluginLegacyFileProofMatches(claudeDir, proof)).toBe(false);
			expectRemovalPreservedTarget();
			expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
			expect(readFileSync(outsideTarget, "utf-8")).toBe("official\n");
		},
	);

	test.skipIf(process.platform === "win32")(
		"cache symlink replacement invalidates proof without removing the legacy target",
		async () => {
			const proof = collectSingleProof();
			const outsideCache = join(root, "outside-cache.md");
			await writeFile(outsideCache, "official\n");
			await rm(cachePath);
			await symlink(outsideCache, cachePath, "file");

			expect(orphanedPluginLegacyFileProofMatches(claudeDir, proof)).toBe(false);
			expectRemovalPreservedTarget();
			expect(lstatSync(cachePath).isSymbolicLink()).toBe(true);
			expect(readFileSync(targetPath, "utf-8")).toBe("official\n");
		},
	);
});
