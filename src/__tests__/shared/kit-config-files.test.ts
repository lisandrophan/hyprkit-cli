import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KIT_CONFIG_FILE,
	KIT_CONFIG_FILES,
	LEGACY_KIT_CONFIG_FILE,
	findKitConfigPath,
	isKitConfigFile,
	isKitIgnoreFile,
	kitConfigPaths,
	resolveKitConfigPath,
} from "@/shared/kit-config-files.js";

describe("kit-config-files", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kit-config-files-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (name: string) => writeFileSync(join(dir, name), "{}");

	describe("findKitConfigPath", () => {
		it("returns null when neither name is present", () => {
			expect(findKitConfigPath(dir)).toBeNull();
		});

		it("finds the current name", () => {
			writeConfig(KIT_CONFIG_FILE);
			expect(findKitConfigPath(dir)).toBe(join(dir, KIT_CONFIG_FILE));
		});

		it("finds the legacy name, so engineer-kit projects still resolve", () => {
			writeConfig(LEGACY_KIT_CONFIG_FILE);
			expect(findKitConfigPath(dir)).toBe(join(dir, LEGACY_KIT_CONFIG_FILE));
		});

		it("prefers the current name when both exist", () => {
			writeConfig(LEGACY_KIT_CONFIG_FILE);
			writeConfig(KIT_CONFIG_FILE);
			expect(findKitConfigPath(dir)).toBe(join(dir, KIT_CONFIG_FILE));
		});

		it("does not throw on a directory that does not exist", () => {
			expect(() => findKitConfigPath(join(dir, "nope"))).not.toThrow();
			expect(findKitConfigPath(join(dir, "nope"))).toBeNull();
		});
	});

	describe("resolveKitConfigPath", () => {
		it("falls back to the current name when nothing exists, so writes create .hk.json", () => {
			expect(resolveKitConfigPath(dir)).toBe(join(dir, KIT_CONFIG_FILE));
		});

		it("follows an existing legacy file, so a write updates it instead of splitting config in two", () => {
			writeConfig(LEGACY_KIT_CONFIG_FILE);
			expect(resolveKitConfigPath(dir)).toBe(join(dir, LEGACY_KIT_CONFIG_FILE));
		});
	});

	describe("kitConfigPaths", () => {
		it("returns both candidates, current name first", () => {
			expect(kitConfigPaths(dir)).toEqual([
				join(dir, KIT_CONFIG_FILE),
				join(dir, LEGACY_KIT_CONFIG_FILE),
			]);
		});
	});

	describe("predicates", () => {
		it("recognises both config names and nothing else", () => {
			for (const name of KIT_CONFIG_FILES) expect(isKitConfigFile(name)).toBe(true);
			expect(isKitConfigFile("settings.json")).toBe(false);
			expect(isKitConfigFile("hk.json")).toBe(false);
			expect(isKitConfigFile(".hkignore")).toBe(false);
		});

		it("recognises both ignore names and nothing else", () => {
			expect(isKitIgnoreFile(".hkignore")).toBe(true);
			expect(isKitIgnoreFile(".ckignore")).toBe(true);
			expect(isKitIgnoreFile(".gitignore")).toBe(false);
			expect(isKitIgnoreFile(".hk.json")).toBe(false);
		});
	});
});
