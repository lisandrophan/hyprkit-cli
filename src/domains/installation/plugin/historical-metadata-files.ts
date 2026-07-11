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
	const seen = new Set<string>();
	const push = (files: unknown) => {
		if (!Array.isArray(files)) return;
		for (const file of files) {
			if (typeof file === "string") {
				const key = normalizeHistoricalPath(file);
				if (seen.has(key)) continue;
				seen.add(key);
				tracked.push({ path: file, ownership: "unknown" });
				continue;
			}
			if (!isRecord(file) || typeof file.path !== "string") continue;
			const key = normalizeHistoricalPath(file.path);
			if (seen.has(key)) continue;
			seen.add(key);
			tracked.push({
				path: file.path,
				ownership: normalizeOwnership(file.ownership),
				...(typeof file.checksum === "string" ? { checksum: file.checksum } : {}),
			});
		}
	};

	let includeTransitionalRoot = true;
	if (isRecord(metadata.kits)) {
		const engineer = metadata.kits.engineer;
		if (!isRecord(engineer)) return [];
		push(engineer.files);
		push(engineer.installedFiles);
		includeTransitionalRoot = Object.keys(metadata.kits).length === 1;
	}

	// metadata-migration preserved root records beside the sole nested kit. Once
	// multiple kits exist, root records are ambiguous and must not be attributed
	// to Engineer; nested Engineer metadata is the only deletion authority.
	if (includeTransitionalRoot) {
		push(metadata.files);
		push(metadata.installedFiles);
	}
	return tracked;
}

function normalizeHistoricalPath(pathValue: string): string {
	return pathValue
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/^\.claude\//, "");
}
