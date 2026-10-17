/**
 * Output for the merge phase: the files an install kept back, and the preview a
 * dry run prints instead of installing.
 */

import type { FileMerger } from "@/domains/installation/file-merger.js";
import { logger } from "@/shared/logger.js";

const MAX_LISTED = 10;

function listPaths(paths: string[], log: (message: string) => void): void {
	for (const path of paths.slice(0, MAX_LISTED)) log(`    ${path}`);
	if (paths.length > MAX_LISTED) log(`    ... and ${paths.length - MAX_LISTED} more`);
}

/**
 * Name the files the merge held back. Staying quiet about this would be as bad as
 * the silent overwrite it replaces: the user needs to know an update was skipped
 * and how to take it.
 */
export function reportKeptFiles(merger: FileMerger, dryRun: boolean): void {
	const verb = dryRun ? "Would keep" : "Kept";

	const rootFiles = merger.getProtectedRootFiles();
	if (rootFiles.length > 0) {
		logger.warning(
			`${verb} ${rootFiles.length} existing project file(s) instead of the kit's version:`,
		);
		listPaths(rootFiles, logger.warning.bind(logger));
	}

	const locallyModified = merger.getLocallyModifiedFiles();
	if (locallyModified.length > 0) {
		logger.warning(
			`${verb} ${locallyModified.length} locally modified kit file(s) — the update for these ${dryRun ? "would not be" : "was not"} applied:`,
		);
		listPaths(locallyModified, logger.warning.bind(logger));
	}

	if (rootFiles.length > 0 || locallyModified.length > 0) {
		logger.warning("    Re-run with --force-overwrite to take the incoming versions.");
	}
}

/** Print what a real run would write. */
export function reportDryRun(merger: FileMerger, pendingDeletions: string[]): void {
	const changes = merger.getPlannedChanges();
	const byAction = (action: string) =>
		changes.filter((c) => c.action === action).map((c) => c.path);

	const created = byAction("create");
	const overwritten = byAction("overwrite");
	const merged = byAction("merge");

	logger.info(
		`Dry run: would create ${created.length}, overwrite ${overwritten.length} and merge ${merged.length} file(s)`,
	);
	if (overwritten.length > 0) {
		logger.info("  Would overwrite:");
		listPaths(overwritten, logger.info.bind(logger));
	}
	if (merged.length > 0) {
		logger.info("  Would merge:");
		listPaths(merged, logger.info.bind(logger));
	}
	if (pendingDeletions.length > 0) {
		logger.info(`  Would apply ${pendingDeletions.length} deprecated-file deletion pattern(s)`);
	}
	reportKeptFiles(merger, true);
}
