export type HistoricalFileOwnership = "ck" | "ck-modified" | "user" | "unknown";

export interface HistoricalTrackedFile {
	path: string;
	ownership: HistoricalFileOwnership;
	checksum?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOwnership(value: unknown): HistoricalFileOwnership {
	if (value === "ck" || value === "ck-modified" || value === "user") return value;
	return "unknown";
}

/**
 * Read every historical Engineer file-list shape without inferring destructive
 * ownership. Old `installedFiles` entries prove that a copied install exists,
 * but they do not carry enough evidence to authorize deleting user content.
 */
export function collectEngineerHistoricalFiles(metadata: unknown): HistoricalTrackedFile[] {
	if (!isRecord(metadata)) return [];

	const tracked: HistoricalTrackedFile[] = [];
	const push = (files: unknown) => {
		if (!Array.isArray(files)) return;
		for (const file of files) {
			if (typeof file === "string") {
				tracked.push({ path: file, ownership: "unknown" });
				continue;
			}
			if (!isRecord(file) || typeof file.path !== "string") continue;
			tracked.push({
				path: file.path,
				ownership: normalizeOwnership(file.ownership),
				...(typeof file.checksum === "string" ? { checksum: file.checksum } : {}),
			});
		}
	};

	if (isRecord(metadata.kits)) {
		const engineer = metadata.kits.engineer;
		if (isRecord(engineer)) {
			push(engineer.files);
			push(engineer.installedFiles);
		}
		return tracked;
	}

	push(metadata.files);
	push(metadata.installedFiles);
	return tracked;
}
