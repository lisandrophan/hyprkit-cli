/**
 * File merging and manifest tracking phase
 * Handles file merge, legacy migration, ownership tracking, and manifest writing
 */

import { join } from "node:path";
import { handleDeletions } from "@/domains/installation/deletion-handler.js";
import { FileMerger } from "@/domains/installation/file-merger.js";
import { LegacyMigration } from "@/domains/migration/legacy-migration.js";
import { getAllTrackedFiles, getKitMetadata } from "@/domains/migration/metadata-migration.js";
import { ReleaseManifestLoader } from "@/domains/migration/release-manifest.js";
import { buildConflictSummary, displayConflictSummary } from "@/domains/ui/conflict-summary.js";
import { FileScanner } from "@/services/file-operations/file-scanner.js";
import {
	buildFileTrackingList,
	trackFilesWithProgress,
} from "@/services/file-operations/manifest/index.js";
import { CommandsPrefix } from "@/services/transformers/commands-prefix.js";
import { logger } from "@/shared/logger.js";
import { output } from "@/shared/output-manager.js";
import type { KitType, Metadata } from "@/types";
import type { ClaudeKitMetadata } from "@/types";
import { pathExists, readFile } from "fs-extra";
import type { InitContext } from "../types.js";

/**
 * Merge files and track ownership
 */
export async function handleMerge(ctx: InitContext): Promise<InitContext> {
	// Note: ctx.release may be undefined in offline mode (--kit-path, --archive)
	// This is valid - we use "local" as fallback version for tracking
	if (
		ctx.cancelled ||
		!ctx.extractDir ||
		!ctx.resolvedDir ||
		!ctx.claudeDir ||
		!ctx.kit ||
		!ctx.kitType
	) {
		return ctx;
	}

	// Determine version for tracking (fallback to "local" for offline installations)
	const installedVersion = ctx.release?.tag_name ?? "local";

	// Scan for custom .claude files to preserve (skip if --fresh)
	let customClaudeFiles: string[] = [];
	if (!ctx.options.fresh) {
		logger.info("Scanning for custom .claude files...");
		const scanSourceDir = ctx.options.global ? join(ctx.extractDir, ".claude") : ctx.extractDir;
		const scanTargetSubdir = ctx.options.global ? "" : ".claude";
		customClaudeFiles = await FileScanner.findCustomFiles(
			ctx.resolvedDir,
			scanSourceDir,
			scanTargetSubdir,
		);
	} else {
		logger.debug("Skipping custom file scan (fresh installation)");
	}

	// Handle selective update logic
	let includePatterns: string[] = [];

	if (ctx.options.only && ctx.options.only.length > 0) {
		includePatterns = ctx.options.only;
		logger.info(`Including only: ${includePatterns.join(", ")}`);
	} else if (!ctx.isNonInteractive) {
		const updateEverything = await ctx.prompts.promptUpdateMode();

		if (!updateEverything) {
			includePatterns = await ctx.prompts.promptDirectorySelection(ctx.options.global);
			logger.info(`Selected directories: ${includePatterns.join(", ")}`);
		}
	}

	output.section("Installing");
	logger.verbose("Installation target", {
		directory: ctx.resolvedDir,
		mode: ctx.options.global ? "global" : "local",
	});

	// Set up file merger
	const merger = new FileMerger();

	if (includePatterns.length > 0) {
		merger.setIncludePatterns(includePatterns);
	}

	if (customClaudeFiles.length > 0) {
		merger.addIgnorePatterns(customClaudeFiles);
		logger.success(`Protected ${customClaudeFiles.length} custom .claude file(s)`);
	}

	if (ctx.options.exclude && ctx.options.exclude.length > 0) {
		merger.addIgnorePatterns(ctx.options.exclude);
	}

	merger.setGlobalFlag(ctx.options.global);
	merger.setForceOverwriteSettings(ctx.options.forceOverwriteSettings);
	merger.setPreserveDeletedSkills(!ctx.options.forceOverwrite && !ctx.options.fresh);
	merger.setRestoreCkHooks(ctx.options.restoreCkHooks);
	merger.setProjectDir(ctx.resolvedDir);
	merger.setKitName(ctx.kit.name);

	// Wire zombie pruner: auto-removes stale engineer-tagged hook entries after merge.
	// hookDir = ~/.claude/hooks (global) or <projectDir>/.claude/hooks (project).
	// ctx.claudeDir is already the resolved .claude directory for both scopes.
	merger.setZombiePrunerHookDir(join(ctx.claudeDir, "hooks"));

	// Set multi-kit context for cross-kit file awareness
	if (ctx.kitType) {
		merger.setMultiKitContext(ctx.claudeDir, ctx.kitType);
	}

	// Hand the previous install's per-file checksums to the merger so an update can
	// tell a kit file the user edited from one it shipped, and hold the edited ones
	// back instead of overwriting them with no backup.
	merger.setTrackedChecksums(
		await loadTrackedChecksums(ctx.claudeDir, ctx.kitType),
		ctx.options.forceOverwrite === true,
	);

	// Load release manifest and handle legacy migration
	const releaseManifest = await ReleaseManifestLoader.load(ctx.extractDir);

	if (releaseManifest) {
		merger.setManifest(releaseManifest);
	}

	// Legacy migration
	if (!ctx.options.fresh && (await pathExists(ctx.claudeDir))) {
		const legacyDetection = await LegacyMigration.detectLegacy(ctx.claudeDir);

		if (legacyDetection.isLegacy && releaseManifest) {
			logger.info("Legacy installation detected - migrating to ownership tracking...");
			await LegacyMigration.migrate(
				ctx.claudeDir,
				releaseManifest,
				ctx.kit.name,
				installedVersion,
				!ctx.isNonInteractive,
			);
			logger.success("Migration complete");
		}
	}

	// Clean up commands directory if using --prefix flag
	if (CommandsPrefix.shouldApplyPrefix(ctx.options)) {
		const cleanupResult = await CommandsPrefix.cleanupCommandsDirectory(
			ctx.resolvedDir,
			ctx.options.global,
			{
				dryRun: ctx.options.dryRun,
				forceOverwrite: ctx.options.forceOverwrite,
				kitType: ctx.kitType,
			},
		);

		if (ctx.options.dryRun) {
			const { OwnershipDisplay } = await import("@/domains/ui/ownership-display.js");
			OwnershipDisplay.displayOperationPreview(cleanupResult.results);
			ctx.prompts.outro("Dry-run complete. No changes were made.");
			return { ...ctx, cancelled: true };
		}
	}

	// Load metadata deletions early — needed for both settings.json hook pruning and file cleanup
	const sourceDir = ctx.options.global ? join(ctx.extractDir, ".claude") : ctx.extractDir;
	const sourceMetadataPath = ctx.options.global
		? join(sourceDir, "metadata.json")
		: join(sourceDir, ".claude", "metadata.json");
	let sourceMetadata: ClaudeKitMetadata | null = null;
	try {
		if (await pathExists(sourceMetadataPath)) {
			const metadataContent = await readFile(sourceMetadataPath, "utf-8");
			sourceMetadata = JSON.parse(metadataContent) as ClaudeKitMetadata;
		}
	} catch (error) {
		logger.debug(`Failed to load source metadata: ${error}`);
	}

	// Pass deletion patterns to merger so settings.json hook pruning can remove stale entries
	if (sourceMetadata?.deletions && sourceMetadata.deletions.length > 0) {
		merger.setDeletions(sourceMetadata.deletions);
	}

	// Merge files
	await merger.merge(sourceDir, ctx.resolvedDir, ctx.isNonInteractive);

	// Name the kit files we held back. Staying quiet about this would be as bad as
	// the silent overwrite it replaces: the user needs to know an update was skipped
	// and how to take it.
	const locallyModified = merger.getLocallyModifiedFiles();
	if (locallyModified.length > 0) {
		logger.warning(
			`Kept ${locallyModified.length} locally modified kit file(s) — the update for these was not applied:`,
		);
		for (const path of locallyModified.slice(0, 10)) logger.warning(`    ${path}`);
		if (locallyModified.length > 10) {
			logger.warning(`    ... and ${locallyModified.length - 10} more`);
		}
		logger.warning("    Re-run with --force-overwrite to take the incoming versions.");
	}

	// Display conflict resolution summary if any conflicts occurred
	const fileConflicts = merger.getFileConflicts();
	if (fileConflicts.length > 0 && !ctx.isNonInteractive) {
		const summary = buildConflictSummary(fileConflicts, [], []);
		displayConflictSummary(summary);
	}

	// Handle deletions from source kit metadata (cleanup deprecated files)
	try {
		if (sourceMetadata?.deletions && sourceMetadata.deletions.length > 0) {
			const deletionResult = await handleDeletions(sourceMetadata, ctx.claudeDir, ctx.kitType);

			if (deletionResult.deletedPaths.length > 0) {
				logger.info(`Removed ${deletionResult.deletedPaths.length} deprecated file(s)`);
				for (const path of deletionResult.deletedPaths) {
					logger.verbose(`  - ${path}`);
				}
			}

			if (deletionResult.preservedPaths.length > 0) {
				logger.verbose(`Preserved ${deletionResult.preservedPaths.length} user-owned file(s)`);
			}
		}
	} catch (error) {
		// Don't fail install on deletion errors - just log and continue
		logger.debug(`Cleanup of deprecated files failed: ${error}`);
	}

	// Build file tracking list and track with progress
	const installedFiles = merger.getAllInstalledFiles();
	const filesToTrack = buildFileTrackingList({
		installedFiles,
		claudeDir: ctx.claudeDir,
		releaseManifest,
		installedVersion,
		isGlobal: ctx.options.global,
		locallyModified: merger.getLocallyModifiedChecksums(),
	});

	await trackFilesWithProgress(filesToTrack, {
		claudeDir: ctx.claudeDir,
		kitName: ctx.kit.name,
		releaseTag: installedVersion,
		mode: ctx.options.global ? "global" : "local",
		kitType: ctx.kitType,
		ignoredSkills: merger.getIgnoredSkillDirectories(),
	});

	return {
		...ctx,
		customClaudeFiles,
		includePatterns,
	};
}

/**
 * Read the checksums recorded for a kit by its previous install.
 *
 * @returns relativePath -> checksum, empty when there is no prior install
 */
async function loadTrackedChecksums(
	claudeDir: string,
	kitType: KitType | undefined,
): Promise<Map<string, string>> {
	const checksums = new Map<string, string>();
	try {
		const raw = await readFile(join(claudeDir, "metadata.json"), "utf-8");
		const metadata = JSON.parse(raw) as Metadata;
		const tracked = kitType
			? (getKitMetadata(metadata, kitType)?.files ?? getAllTrackedFiles(metadata))
			: getAllTrackedFiles(metadata);
		for (const file of tracked) {
			if (file.ownership === "user") continue;
			checksums.set(file.path, file.checksum);
		}
	} catch {
		// No metadata, unreadable, or malformed: a first install has nothing to protect.
	}
	return checksums;
}
