import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { InitContext } from "@/commands/init/types.js";
import {
	type CodexPluginInstallResult,
	type CodexPluginPreparation,
	type InstallCodexPluginOptions,
	type RemoveCodexPluginResult,
	prepareCodexPlugin,
	removeCodexPlugin,
} from "@/domains/installation/plugin/codex-plugin-installer.js";
import {
	type MigrateResult,
	migrateLegacyToPlugin,
} from "@/domains/installation/plugin/migrate-legacy-to-plugin.js";
import {
	type UninstallPluginResult,
	uninstallEnginePlugin,
} from "@/domains/installation/plugin/uninstall-plugin.js";
import { updateInstallModePreference } from "@/services/file-operations/manifest/manifest-updater.js";
import { logger } from "@/shared/logger.js";
import { PathResolver } from "@/shared/path-resolver.js";

const ENGINEER_KIT = "engineer";

export interface PluginInstallDeps {
	/** Injectable for tests; defaults to the real migrate flow. */
	migrate?: typeof migrateLegacyToPlugin;
	/** Injectable for tests; defaults to the real Codex plugin install flow. */
	installCodex?: (options: InstallCodexPluginOptions) => Promise<CodexPluginInstallResult>;
	/** Transactional Codex preparation. Preferred over installCodex when supplied. */
	prepareCodex?: typeof prepareCodexPlugin;
	/** Injectable for tests; defaults to the real Claude plugin removal flow. */
	uninstallClaudePlugin?: typeof uninstallEnginePlugin;
	/** Injectable for tests; defaults to the real Codex plugin removal flow. */
	removeCodexPlugin?: typeof removeCodexPlugin;
	/** Persist canonical preference after the selected path verifies usable. */
	persistPreference?: typeof updateInstallModePreference;
	/** Override the staged-source base dir (tests). */
	stageBaseDir?: string;
}

export interface PluginStageDeps {
	transactionId?: string;
	copyDirectory?: (source: string, target: string) => void;
	validateSource?: (sourceDir: string) => void;
	renameDirectory?: (source: string, target: string) => void;
}

export interface PluginStageTransaction {
	pluginSourceDir: string;
	commit: () => void;
	rollback: () => void;
}

/**
 * Phase 7.5 (#689): install the engineer kit as a Claude Code plugin for GLOBAL
 * (user-scope) installs.
 *
 * handleMerge has already copied the kit, so the selected surface can be verified
 * before CK-owned state from the other mode is removed. Explicit plugin failures are
 * surfaced; normal mode removes only verified CK plugin registrations and cache.
 */
export async function handlePluginInstall(
	ctx: InitContext,
	deps: PluginInstallDeps = {},
): Promise<InitContext> {
	// Only the engineer kit ships as a plugin, and only global (user-scope) installs migrate.
	if (ctx.kitType !== ENGINEER_KIT || !ctx.options?.global || !ctx.extractDir || !ctx.claudeDir) {
		return ctx;
	}

	const migrate = deps.migrate ?? migrateLegacyToPlugin;
	const legacyInstallCodex = deps.installCodex;
	const prepareCodex =
		deps.prepareCodex ??
		(legacyInstallCodex
			? async (options: InstallCodexPluginOptions): Promise<CodexPluginPreparation> => ({
					result: await legacyInstallCodex(options),
					commit: () => {},
					rollback: async () => ({
						ok: true,
						detail: "Injected Codex installer has no transactional state",
					}),
				})
			: prepareCodexPlugin);
	const uninstallClaude = deps.uninstallClaudePlugin ?? uninstallEnginePlugin;
	const removeCodex = deps.removeCodexPlugin ?? removeCodexPlugin;
	const persistPreference = deps.persistPreference ?? updateInstallModePreference;

	if (ctx.options.installMode !== "plugin") {
		const cleanupErrors: string[] = [];
		try {
			const result = await uninstallClaude({ claudeDir: ctx.claudeDir });
			logLegacyPluginCleanup(result);
			if (result.error || result.pluginStillInstalled) {
				cleanupErrors.push(
					`Claude plugin cleanup failed while switching to Normal skills: ${result.error ?? "plugin remains registered"}`,
				);
			}
		} catch (err) {
			logger.verbose(`Claude plugin cleanup skipped: ${(err as Error).message}`);
			cleanupErrors.push(`Claude plugin cleanup failed: ${(err as Error).message}`);
		}
		try {
			const result = await removeCodex();
			logCodexPluginCleanup(result);
			if (result.error || result.pluginStillInstalled) {
				cleanupErrors.push(
					`Codex plugin cleanup failed while switching to Normal skills: ${result.error ?? "plugin remains registered"}`,
				);
			}
		} catch (err) {
			logger.verbose(`Codex plugin cleanup skipped: ${(err as Error).message}`);
			cleanupErrors.push(`Codex plugin cleanup failed: ${(err as Error).message}`);
		}
		if (cleanupErrors.length > 0) {
			throw new Error(cleanupErrors.join("; "));
		}
		return ctx;
	}

	let stageTransaction: PluginStageTransaction | null = null;
	let codexPreparation: CodexPluginPreparation | null = null;
	let preferenceSnapshot: Buffer | null | undefined;
	try {
		stageTransaction = preparePluginSourceTransaction(ctx.extractDir, deps.stageBaseDir);
		const { pluginSourceDir } = stageTransaction;
		codexPreparation = await prepareCodex({ pluginSourceDir });
		const codexResult = codexPreparation.result;
		logCodexPluginResult(codexResult);
		if (codexResult.action === "install-failed") {
			throw new Error(`Codex plugin install failed: ${codexResult.error ?? codexResult.action}`);
		}
		preferenceSnapshot = snapshotFile(join(ctx.claudeDir, "metadata.json"));
		await persistPreference(ctx.claudeDir, "plugin");
		try {
			const result = await migrate({ pluginSourceDir, claudeDir: ctx.claudeDir });
			logPluginResult(result);
			if (result.action === "skipped-cc-unsupported") {
				throw new Error(
					"Claude plugin installation is unavailable in this Claude Code version. Choose Normal skills or update Claude Code before opting in to plugin mode.",
				);
			}
			if (ctx.options.installMode === "plugin" && !result.pluginVerified) {
				throw new Error(`Claude plugin install failed: ${result.error ?? result.action}`);
			}
		} catch (err) {
			if (ctx.options.installMode === "plugin") {
				throw err;
			}
			logger.verbose(
				`Claude plugin install skipped (legacy copy retained): ${(err as Error).message}`,
			);
		}
		stageTransaction.commit();
		codexPreparation.commit();
	} catch (err) {
		const rollbackErrors: string[] = [];
		if (preferenceSnapshot !== undefined) {
			try {
				restoreFile(join(ctx.claudeDir, "metadata.json"), preferenceSnapshot);
			} catch (rollbackError) {
				rollbackErrors.push(`preference rollback failed: ${(rollbackError as Error).message}`);
			}
		}
		try {
			stageTransaction?.rollback();
		} catch (rollbackError) {
			rollbackErrors.push(`stage rollback failed: ${(rollbackError as Error).message}`);
		}
		if (codexPreparation) {
			try {
				const rollback = await codexPreparation.rollback();
				if (!rollback.ok) rollbackErrors.push(`Codex rollback failed: ${rollback.detail}`);
			} catch (rollbackError) {
				rollbackErrors.push(`Codex rollback failed: ${(rollbackError as Error).message}`);
			}
		}
		const failure =
			rollbackErrors.length > 0
				? new Error(`${(err as Error).message}; ${rollbackErrors.join("; ")}`)
				: err;
		if (ctx.options.installMode === "plugin") {
			throw failure;
		}
		// Never fail init over the plugin path — the legacy copy from handleMerge stands.
		logger.verbose(`Plugin staging skipped (legacy copy retained): ${(failure as Error).message}`);
	}
	return ctx;
}

function snapshotFile(filePath: string): Buffer | null {
	return existsSync(filePath) ? readFileSync(filePath) : null;
}

function restoreFile(filePath: string, content: Buffer | null): void {
	if (content === null) {
		rmSync(filePath, { force: true });
		return;
	}
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
}

function logLegacyPluginCleanup(result: UninstallPluginResult): void {
	if (result.uninstalled || result.staleCacheRemoved) {
		logger.info("Removed ClaudeKit Engineer plugin state for Normal skills mode.");
	} else {
		logger.verbose("No ClaudeKit Engineer Claude plugin state found for Normal skills mode.");
	}
}

/**
 * Stage the extracted kit payload to a stable marketplace source dir and synthesize
 * the marketplace.json. The release archive ships `.claude/` (which contains
 * `.claude-plugin/plugin.json`) but not a repo-root marketplace, so the CLI writes
 * one pointing at `./.claude`. A stable path is used so `claude plugin marketplace
 * update` keeps resolving after init.
 */
export function stagePluginSource(
	extractDir: string,
	stageBaseDir?: string,
	deps: PluginStageDeps = {},
): string {
	const transaction = preparePluginSourceTransaction(extractDir, stageBaseDir, deps);
	transaction.commit();
	return transaction.pluginSourceDir;
}

export function preparePluginSourceTransaction(
	extractDir: string,
	stageBaseDir?: string,
	deps: PluginStageDeps = {},
): PluginStageTransaction {
	const base = stageBaseDir ?? join(PathResolver.getCacheDir(true), "ck-plugin-source");
	const payloadSrc = join(extractDir, ".claude");
	if (!existsSync(payloadSrc)) {
		throw new Error(`plugin payload not found in archive: ${payloadSrc}`);
	}
	return preparePluginSourceReplacement(payloadSrc, base, deps);
}

export function replacePluginSourceAtomically(
	payloadSrc: string,
	base: string,
	deps: PluginStageDeps = {},
): string {
	const transaction = preparePluginSourceReplacement(payloadSrc, base, deps);
	transaction.commit();
	return transaction.pluginSourceDir;
}

function preparePluginSourceReplacement(
	payloadSrc: string,
	base: string,
	deps: PluginStageDeps = {},
): PluginStageTransaction {
	const transactionId = deps.transactionId ?? randomUUID();
	const temporary = `${base}.tmp-${transactionId}`;
	const backup = `${base}.backup-${transactionId}`;
	const copyDirectory =
		deps.copyDirectory ??
		((source: string, target: string) => cpSync(source, target, { recursive: true }));
	const validateSource = deps.validateSource ?? validatePluginSource;
	const renameDirectory = deps.renameDirectory ?? renameSync;
	let previousMoved = false;
	let settled = false;

	rmSync(temporary, { recursive: true, force: true });
	rmSync(backup, { recursive: true, force: true });
	try {
		buildPluginSource(payloadSrc, temporary, copyDirectory);
		validateSource(temporary);
		if (existsSync(base)) {
			renameDirectory(base, backup);
			previousMoved = true;
		}
		renameDirectory(temporary, base);
		return {
			pluginSourceDir: base,
			commit: () => {
				if (settled) return;
				settled = true;
				previousMoved = false;
				try {
					rmSync(backup, { recursive: true, force: true });
					rmSync(temporary, { recursive: true, force: true });
				} catch (error) {
					logger.verbose(
						`Plugin stage transaction residue cleanup skipped: ${(error as Error).message}`,
					);
				}
			},
			rollback: () => {
				if (settled) return;
				settled = true;
				rmSync(base, { recursive: true, force: true });
				if (previousMoved && existsSync(backup)) renameDirectory(backup, base);
				previousMoved = false;
				rmSync(temporary, { recursive: true, force: true });
				rmSync(backup, { recursive: true, force: true });
			},
		};
	} catch (error) {
		if (previousMoved && existsSync(backup)) {
			rmSync(base, { recursive: true, force: true });
			renameDirectory(backup, base);
			previousMoved = false;
		}
		throw error;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
		if (!previousMoved && !settled) rmSync(backup, { recursive: true, force: true });
	}
}

function buildPluginSource(
	payloadSrc: string,
	targetDir: string,
	copyDirectory: (source: string, target: string) => void,
): void {
	mkdirSync(targetDir, { recursive: true });
	const stagedPayload = join(targetDir, ".claude");
	copyDirectory(payloadSrc, stagedPayload);
	ensureCodexPluginManifest(stagedPayload);

	const claudeMarketplace = {
		name: "claudekit",
		owner: { name: "ClaudeKit" },
		plugins: [{ name: "ck", source: "./.claude", description: "ClaudeKit Engineer" }],
	};
	mkdirSync(join(targetDir, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(targetDir, ".claude-plugin", "marketplace.json"),
		`${JSON.stringify(claudeMarketplace, null, 2)}\n`,
		"utf-8",
	);

	const codexMarketplace = {
		name: "claudekit",
		interface: { displayName: "ClaudeKit" },
		plugins: [
			{
				name: "ck",
				source: { source: "local", path: "./.claude" },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: "Productivity",
			},
		],
	};
	mkdirSync(join(targetDir, ".agents", "plugins"), { recursive: true });
	writeFileSync(
		join(targetDir, ".agents", "plugins", "marketplace.json"),
		`${JSON.stringify(codexMarketplace, null, 2)}\n`,
		"utf-8",
	);
}

function validatePluginSource(sourceDir: string): void {
	const claudeManifest = readRequiredJson(
		join(sourceDir, ".claude", ".claude-plugin", "plugin.json"),
		"Claude plugin manifest",
	);
	const codexManifest = readRequiredJson(
		join(sourceDir, ".claude", ".codex-plugin", "plugin.json"),
		"Codex plugin manifest",
	);
	const claudeMarketplace = readRequiredJson(
		join(sourceDir, ".claude-plugin", "marketplace.json"),
		"Claude marketplace",
	);
	const codexMarketplace = readRequiredJson(
		join(sourceDir, ".agents", "plugins", "marketplace.json"),
		"Codex marketplace",
	);
	if (claudeManifest.name !== "ck" || codexManifest.name !== "ck") {
		throw new Error("staged plugin manifests must identify the ck plugin");
	}
	if (!marketplaceReferencesPluginSource(claudeMarketplace, false)) {
		throw new Error("staged Claude marketplace does not reference ./.claude");
	}
	if (!marketplaceReferencesPluginSource(codexMarketplace, true)) {
		throw new Error("staged Codex marketplace does not reference ./.claude");
	}
}

function readRequiredJson(filePath: string, label: string): Record<string, unknown> {
	const parsed = readJsonSafe(filePath);
	if (!parsed) throw new Error(`${label} is missing or invalid: ${filePath}`);
	return parsed;
}

function marketplaceReferencesPluginSource(
	marketplace: Record<string, unknown>,
	nestedSource: boolean,
): boolean {
	if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) return false;
	const plugin = marketplace.plugins[0];
	if (!isRecord(plugin) || plugin.name !== "ck") return false;
	if (!nestedSource) return plugin.source === "./.claude";
	return isRecord(plugin.source) && plugin.source.path === "./.claude";
}

function ensureCodexPluginManifest(pluginRoot: string): void {
	const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
	if (existsSync(manifestPath)) return;

	const claudeManifest = readJsonSafe(join(pluginRoot, ".claude-plugin", "plugin.json"));
	const manifest = pruneUndefined({
		name: stringField(claudeManifest, "name") ?? "ck",
		version: stringField(claudeManifest, "version") ?? "0.0.0",
		description:
			stringField(claudeManifest, "description") ??
			"ClaudeKit Engineer — multi-agent planning, code review, debugging, and workflow skills for Codex.",
		author: authorField(claudeManifest),
		homepage: stringField(claudeManifest, "homepage"),
		repository: stringField(claudeManifest, "repository"),
		license: stringField(claudeManifest, "license"),
		keywords: ["claudekit", "codex", "skills", "agents", "workflow"],
		skills: "./skills/",
		interface: {
			displayName: "ClaudeKit Engineer",
			shortDescription: "ClaudeKit planning, review, debugging, and workflow skills.",
			longDescription:
				"ClaudeKit Engineer provides planning, code review, debugging, testing, browser workflow, and implementation skills for Codex.",
			developerName: "ClaudeKit",
			category: "Productivity",
			capabilities: ["Skills"],
			websiteURL: "https://github.com/claudekit/claudekit-engineer",
		},
	});

	mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function stringField(source: Record<string, unknown> | null, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function authorField(source: Record<string, unknown> | null): { name: string } {
	const author = source?.author;
	if (isRecord(author) && typeof author.name === "string" && author.name.trim() !== "") {
		return { name: author.name };
	}
	return { name: "ClaudeKit" };
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logPluginResult(result: MigrateResult): void {
	switch (result.action) {
		case "migrated-from-legacy":
			logger.info("Migrated ClaudeKit Engineer to plugin install (legacy skills cleaned).");
			break;
		case "installed-fresh":
			logger.info("Installed ClaudeKit Engineer as a Claude Code plugin.");
			break;
		case "noop-already-plugin":
			logger.verbose("ClaudeKit Engineer already installed as a plugin.");
			break;
		case "skipped-cc-unsupported":
			logger.verbose("Claude Code lacks plugin support; kept the legacy copy.");
			break;
		case "install-failed":
			logger.verbose(`Plugin install did not verify; kept the legacy copy. ${result.error ?? ""}`);
			break;
	}
}

function logCodexPluginResult(result: CodexPluginInstallResult): void {
	switch (result.action) {
		case "installed":
			logger.info("Installed ClaudeKit Engineer as a Codex plugin.");
			break;
		case "skipped-codex-unsupported":
			logger.verbose("Codex plugin support unavailable; skipped Codex plugin install.");
			break;
		case "install-failed":
			logger.verbose(`Codex plugin install did not verify. ${result.error ?? ""}`);
			break;
	}
}

function logCodexPluginCleanup(result: RemoveCodexPluginResult): void {
	if (result.removed || result.marketplaceRemoved) {
		logger.info("Removed ClaudeKit Engineer Codex plugin state for Normal skills mode.");
	} else {
		logger.verbose("No ClaudeKit Engineer Codex plugin state found for Normal skills mode.");
	}
}
