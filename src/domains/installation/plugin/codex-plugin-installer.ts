import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import {
	CK_MARKETPLACE_NAME,
	CK_PLUGIN_NAME,
} from "@/domains/installation/plugin/install-mode-detector.js";
import { versionsMatch } from "@/domains/versioning/checking/version-utils.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CodexRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
}

export interface CodexRunOptions {
	/** Override CODEX_HOME for tests and isolated smoke runs. */
	codexHome?: string;
	timeoutMs?: number;
}

export type CodexRunner = (args: string[], opts?: CodexRunOptions) => Promise<CodexRunResult>;

export interface CodexExecutableCandidate {
	command: string;
	argsPrefix: string[];
}

export function resolveCodexExecutable(_platformName: NodeJS.Platform = process.platform): string {
	return "codex";
}

export function shouldRunCodexInShell(_platformName: NodeJS.Platform = process.platform): boolean {
	return false;
}

export function resolveCodexExecutableCandidates(
	platformName: NodeJS.Platform = process.platform,
): CodexExecutableCandidate[] {
	if (platformName === "win32") {
		return [
			{ command: "codex", argsPrefix: [] },
			{ command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "codex.cmd"] },
		];
	}
	return [{ command: resolveCodexExecutable(platformName), argsPrefix: [] }];
}

export const defaultCodexRunner: CodexRunner = async (args, opts) => {
	const env = { ...process.env };
	if (opts?.codexHome) env.CODEX_HOME = opts.codexHome;

	let lastError: unknown = null;
	const candidates = resolveCodexExecutableCandidates();
	for (const [index, candidate] of candidates.entries()) {
		try {
			const { stdout, stderr } = await execFileAsync(
				candidate.command,
				[...candidate.argsPrefix, ...args],
				{
					env,
					shell: shouldRunCodexInShell(),
					timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
				},
			);
			return { ok: true, stdout: String(stdout), stderr: String(stderr), code: 0 };
		} catch (err) {
			lastError = err;
			if (index < candidates.length - 1 && isSpawnResolutionError(err)) {
				continue;
			}
			break;
		}
	}

	const e = lastError as {
		stdout?: string | Buffer;
		stderr?: string | Buffer;
		code?: number | string;
		message?: string;
	};
	return {
		ok: false,
		stdout: e?.stdout ? String(e.stdout) : "",
		stderr: e?.stderr ? String(e.stderr) : (e?.message ?? ""),
		code: typeof e?.code === "number" ? e.code : null,
	};
};

function isSpawnResolutionError(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	return code === "ENOENT" || code === "EACCES" || code === "EINVAL";
}

export type CodexPluginInstallAction = "installed" | "skipped-codex-unsupported" | "install-failed";

export type CodexPluginStatus =
	| "codex-unavailable"
	| "plugins-unsupported"
	| "missing"
	| "disabled"
	| "installed-current"
	| "installed-stale-version"
	| "installed-stale-source"
	| "unknown";

export interface CodexPluginStateOptions {
	expectedVersion?: string | null;
	expectedMarketplace?: string | null;
	expectedSource?: string | null;
}

export interface CodexPluginState {
	status: CodexPluginStatus;
	pluginId: string;
	enabled: boolean;
	installed: boolean;
	installedVersion: string | null;
	expectedVersion: string | null;
	marketplace: string | null;
	expectedMarketplace: string | null;
	source: string | null;
	expectedSource: string | null;
	shouldRefresh: boolean;
	error?: string;
}

export interface CodexPluginInstallResult {
	action: CodexPluginInstallAction;
	pluginVerified: boolean;
	error?: string;
}

export interface CodexPluginRollbackResult {
	ok: boolean;
	detail: string;
}

export interface CodexPluginPreparation {
	result: CodexPluginInstallResult;
	commit(): void;
	rollback(): Promise<CodexPluginRollbackResult>;
}

export interface RemoveCodexPluginResult {
	removed: boolean;
	marketplaceRemoved: boolean;
	pluginStillInstalled?: boolean;
	verificationStatus?: CodexPluginStatus;
	error?: string;
}

export interface InstallCodexPluginOptions {
	/** Staged kit dir containing .agents/plugins/marketplace.json. */
	pluginSourceDir: string;
	installer?: CodexPluginInstaller;
	codexHome?: string;
}

export class CodexPluginInstaller {
	constructor(
		private readonly run: CodexRunner = defaultCodexRunner,
		private readonly codexHome?: string,
	) {}

	private opts(timeoutMs?: number): CodexRunOptions {
		return { codexHome: this.codexHome, timeoutMs };
	}

	async isCodexAvailable(): Promise<boolean> {
		return (await this.run(["--version"], this.opts(15_000))).ok;
	}

	async isPluginSupported(): Promise<boolean> {
		const r = await this.run(["plugin", "--help"], this.opts(15_000));
		return r.ok && /marketplace/i.test(r.stdout + r.stderr);
	}

	async marketplaceAdd(source: string): Promise<CodexRunResult> {
		return this.run(["plugin", "marketplace", "add", source], this.opts());
	}

	async marketplaceRemove(name: string = CK_MARKETPLACE_NAME): Promise<CodexRunResult> {
		return this.run(["plugin", "marketplace", "remove", name], this.opts());
	}

	async add(): Promise<CodexRunResult> {
		return this.run(["plugin", "add", `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`], this.opts());
	}

	async remove(): Promise<CodexRunResult> {
		return this.run(["plugin", "remove", `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`], this.opts());
	}

	async listJson(): Promise<CodexRunResult> {
		return this.run(["plugin", "list", "--json"], this.opts(15_000));
	}

	async listText(): Promise<CodexRunResult> {
		return this.run(["plugin", "list"], this.opts(15_000));
	}

	async verifyInstalled(): Promise<boolean> {
		const state = await detectCodexPluginListState(this);
		return (
			state.status === "installed-current" ||
			state.status === "installed-stale-version" ||
			state.status === "installed-stale-source"
		);
	}
}

interface CodexPluginListEntry {
	pluginId: string | null;
	installed: boolean;
	enabled: boolean;
	version: string | null;
	marketplace: string | null;
	source: string | null;
}

function createState(
	status: CodexPluginStatus,
	entry: CodexPluginListEntry | null,
	options: CodexPluginStateOptions = {},
	error?: string,
): CodexPluginState {
	const pluginId = `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`;
	return {
		status,
		pluginId,
		enabled: entry?.enabled ?? false,
		installed: entry?.installed ?? false,
		installedVersion: entry?.version ?? null,
		expectedVersion: options.expectedVersion ?? null,
		marketplace: entry?.marketplace ?? null,
		expectedMarketplace: options.expectedMarketplace ?? CK_MARKETPLACE_NAME,
		source: entry?.source ?? null,
		expectedSource: options.expectedSource ?? null,
		shouldRefresh:
			status === "missing" ||
			status === "disabled" ||
			status === "installed-stale-version" ||
			status === "installed-stale-source",
		...(error ? { error } : {}),
	};
}

function classifyCodexPluginEntry(
	entry: CodexPluginListEntry | null,
	options: CodexPluginStateOptions = {},
): CodexPluginState {
	if (!entry) return createState("missing", null, options);
	if (!entry.installed) return createState("disabled", entry, options);

	const expectedMarketplace = options.expectedMarketplace ?? CK_MARKETPLACE_NAME;
	if (
		options.expectedMarketplace &&
		(!entry.marketplace || entry.marketplace !== expectedMarketplace)
	) {
		return createState("installed-stale-source", entry, options);
	}
	if (
		options.expectedSource &&
		(!entry.source || !pluginSourceMatches(entry.source, options.expectedSource))
	) {
		return createState("installed-stale-source", entry, options);
	}
	if (
		options.expectedVersion &&
		(!entry.version || !versionsMatch(entry.version, options.expectedVersion))
	) {
		return createState("installed-stale-version", entry, options);
	}
	if (!entry.enabled) return createState("disabled", entry, options);

	return createState("installed-current", entry, options);
}

function pluginSourceMatches(actual: string, expected: string): boolean {
	if (actual === expected) return true;

	const normalizedActual = normalizeLocalSourcePath(actual);
	const normalizedExpected = normalizeLocalSourcePath(expected);
	return (
		normalizedActual !== null &&
		normalizedExpected !== null &&
		normalizedActual === normalizedExpected
	);
}

function normalizeLocalSourcePath(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

	const resolved = resolve(trimmed);
	const canonical = existsSync(resolved) ? realpathSync.native(resolved) : resolved;
	const normalized = normalize(canonical);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseTextPluginList(output: string): CodexPluginListEntry | null {
	const pluginId = `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`.replace(
		/[.*+?^${}()|[\]\\]/g,
		"\\$&",
	);
	const row = new RegExp(`^\\s*(${pluginId})\\s+(.*)$`, "im").exec(output);
	if (!row) return null;
	const details = row[2] ?? "";
	const versionMatch = details.match(/\b(v?\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/);
	return {
		pluginId: `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`,
		installed: /\binstalled\b/i.test(details),
		enabled: /\benabled\b/i.test(details) && !/\bdisabled\b/i.test(details),
		version: versionMatch?.[1] ?? null,
		marketplace: CK_MARKETPLACE_NAME,
		source: null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return null;
}

function sourceField(source: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim() !== "") return value;
		if (isRecord(value)) {
			const nested = stringField(value, ["path", "sourcePath", "url"]);
			if (nested) return nested;
		}
	}
	return null;
}

function booleanField(
	source: Record<string, unknown>,
	key: string,
	defaultValue: boolean,
): boolean {
	const value = source[key];
	return typeof value === "boolean" ? value : defaultValue;
}

function parseJsonPluginList(output: string): CodexPluginListEntry[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}

	const rawEntries = Array.isArray(parsed)
		? parsed
		: isRecord(parsed)
			? (parsed.installed ?? parsed.plugins ?? parsed.entries)
			: null;
	if (!Array.isArray(rawEntries)) return null;

	return rawEntries.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const pluginId =
			stringField(entry, ["pluginId", "id"]) ??
			(stringField(entry, ["name"]) === CK_PLUGIN_NAME
				? `${CK_PLUGIN_NAME}@${stringField(entry, ["marketplace", "marketplaceName"]) ?? CK_MARKETPLACE_NAME}`
				: null);
		if (pluginId !== `${CK_PLUGIN_NAME}@${CK_MARKETPLACE_NAME}`) return [];

		return [
			{
				pluginId,
				installed: booleanField(entry, "installed", true),
				enabled: booleanField(entry, "enabled", false),
				version: stringField(entry, ["version", "pluginVersion", "manifestVersion"]),
				marketplace: stringField(entry, ["marketplace", "marketplaceName"]),
				source: sourceField(entry, ["source", "path", "sourcePath"]),
			},
		];
	});
}

export async function detectCodexPluginState(
	installer: CodexPluginInstaller = new CodexPluginInstaller(),
	options: CodexPluginStateOptions = {},
): Promise<CodexPluginState> {
	if (!(await installer.isCodexAvailable())) {
		return createState("codex-unavailable", null, options);
	}
	if (!(await installer.isPluginSupported())) {
		return createState("plugins-unsupported", null, options);
	}

	return detectCodexPluginListState(installer, options);
}

async function detectCodexPluginListState(
	installer: CodexPluginInstaller,
	options: CodexPluginStateOptions = {},
): Promise<CodexPluginState> {
	const json = await installer.listJson();
	if (json.ok) {
		const entries = parseJsonPluginList(json.stdout);
		if (entries) return classifyCodexPluginEntry(entries[0] ?? null, options);
	}

	const text = await installer.listText();
	if (text.ok)
		return classifyCodexPluginEntry(parseTextPluginList(text.stdout + text.stderr), options);

	return createState(
		"unknown",
		null,
		options,
		json.stderr || text.stderr || "codex plugin list failed",
	);
}

export async function installCodexPlugin(
	opts: InstallCodexPluginOptions,
): Promise<CodexPluginInstallResult> {
	const preparation = await prepareCodexPlugin(opts);
	preparation.commit();
	return preparation.result;
}

export async function prepareCodexPlugin(
	opts: InstallCodexPluginOptions,
): Promise<CodexPluginPreparation> {
	const installer = opts.installer ?? new CodexPluginInstaller(undefined, opts.codexHome);

	if (!(await installer.isCodexAvailable()) || !(await installer.isPluginSupported())) {
		return inertPreparation({ action: "skipped-codex-unsupported", pluginVerified: false });
	}

	const added = await addOrReplaceMarketplace(installer, opts.pluginSourceDir);
	if (!added.ok) {
		return inertPreparation({
			action: "install-failed",
			pluginVerified: false,
			error: added.error,
		});
	}

	const installed = await installer.add();
	if (!installed.ok) {
		const rollback = added.rollback ? await added.rollback() : null;
		return inertPreparation({
			action: "install-failed",
			pluginVerified: false,
			error: appendRollback(`codex plugin add failed: ${installed.stderr.trim()}`, rollback),
		});
	}

	const verified = await installer.verifyInstalled();
	if (!verified) {
		const rollback = added.rollback ? await added.rollback() : null;
		return inertPreparation({
			action: "install-failed",
			pluginVerified: false,
			error: appendRollback("codex plugin did not verify after install", rollback),
		});
	}
	return activePreparation(
		{ action: "installed", pluginVerified: true },
		added.rollback ?? (async () => "no Codex marketplace change required"),
	);
}

function inertPreparation(result: CodexPluginInstallResult): CodexPluginPreparation {
	return {
		result,
		commit: () => {},
		rollback: async () => ({ ok: true, detail: "Codex preparation already settled" }),
	};
}

function activePreparation(
	result: CodexPluginInstallResult,
	rollbackAction: () => Promise<string>,
): CodexPluginPreparation {
	let active = true;
	return {
		result,
		commit: () => {
			active = false;
		},
		rollback: async () => {
			if (!active) return { ok: true, detail: "Codex preparation already committed" };
			active = false;
			const detail = await rollbackAction();
			return { ok: !/failed/i.test(detail), detail };
		},
	};
}

async function addOrReplaceMarketplace(
	installer: CodexPluginInstaller,
	pluginSourceDir: string,
): Promise<{ ok: true; rollback?: () => Promise<string> } | { ok: false; error: string }> {
	const added = await installer.marketplaceAdd(pluginSourceDir);
	if (added.ok) {
		return {
			ok: true,
			rollback: () => removePreparedMarketplace(installer),
		};
	}

	const error = added.stderr.trim();
	if (!isMarketplaceAlreadyRegistered(error)) {
		return { ok: false, error: `codex marketplace add failed: ${error}` };
	}

	const previousState = await detectCodexPluginListState(installer, {
		expectedSource: join(pluginSourceDir, ".claude"),
	});
	const recoveredMarketplaceSource = marketplaceSourceFromAddError(error);
	if (previousState.status === "unknown" && !recoveredMarketplaceSource) {
		return {
			ok: false,
			error: `codex marketplace refresh skipped: registration is irrecoverably unknown because no safe previous source was reported (${previousState.error ?? error})`,
		};
	}
	if (previousState.installed && previousState.status !== "installed-stale-source") {
		return {
			ok: true,
			rollback: () => reloadMarketplaceAndPlugin(installer, pluginSourceDir),
		};
	}
	const isStaleSource =
		previousState.status === "installed-stale-source" ||
		(previousState.status === "unknown" && recoveredMarketplaceSource !== null) ||
		hasDifferentMarketplaceSource(error);
	if (!isStaleSource) {
		return {
			ok: true,
			rollback: () => reloadMarketplaceAndPlugin(installer, pluginSourceDir),
		};
	}

	const previousMarketplaceSource =
		marketplaceRootFromPluginSource(previousState.source) ?? recoveredMarketplaceSource;
	if (!previousMarketplaceSource) {
		return {
			ok: false,
			error: `codex marketplace refresh skipped: previous source could not be determined safely (${error})`,
		};
	}
	const removed = await installer.marketplaceRemove(CK_MARKETPLACE_NAME);
	if (!removed.ok) {
		return {
			ok: false,
			error: `codex marketplace remove failed: ${removed.stderr.trim() || error}`,
		};
	}
	const readded = await installer.marketplaceAdd(pluginSourceDir);
	const rollback = async (): Promise<string> => {
		await installer.marketplaceRemove(CK_MARKETPLACE_NAME);
		const restored = await installer.marketplaceAdd(previousMarketplaceSource);
		if (!restored.ok) {
			return `rollback failed: ${restored.stderr.trim() || "previous marketplace could not be restored"}`;
		}
		if (previousState.installed || previousState.status === "unknown") {
			const pluginRestored = await installer.add();
			if (!pluginRestored.ok) {
				return `marketplace restored but plugin rollback failed: ${pluginRestored.stderr.trim()}`;
			}
		}
		return "restored previous marketplace and plugin state";
	};
	if (readded.ok) return { ok: true, rollback };

	const rollbackDetail = await rollback();

	return {
		ok: false,
		error: `codex marketplace refresh failed: ${readded.stderr.trim() || error}; ${rollbackDetail}`,
	};
}

async function removePreparedMarketplace(installer: CodexPluginInstaller): Promise<string> {
	const removedPlugin = await installer.remove();
	const removedMarketplace = await installer.marketplaceRemove(CK_MARKETPLACE_NAME);
	return removedPlugin.ok && removedMarketplace.ok
		? "removed newly prepared Codex plugin and marketplace"
		: `Codex rollback failed: ${removedPlugin.stderr.trim() || removedMarketplace.stderr.trim() || "cleanup did not verify"}`;
}

async function reloadMarketplaceAndPlugin(
	installer: CodexPluginInstaller,
	source: string,
): Promise<string> {
	await installer.remove();
	const removedMarketplace = await installer.marketplaceRemove(CK_MARKETPLACE_NAME);
	if (!removedMarketplace.ok) {
		return `Codex rollback failed: ${removedMarketplace.stderr.trim() || "marketplace removal failed"}`;
	}
	const restoredMarketplace = await installer.marketplaceAdd(source);
	if (!restoredMarketplace.ok) {
		return `Codex rollback failed: ${restoredMarketplace.stderr.trim() || "marketplace restore failed"}`;
	}
	const restoredPlugin = await installer.add();
	return restoredPlugin.ok
		? "reloaded previous Codex marketplace and plugin state"
		: `Codex rollback failed: ${restoredPlugin.stderr.trim() || "plugin restore failed"}`;
}

function isMarketplaceAlreadyRegistered(error: string): boolean {
	return /\balready\b/i.test(error) && /\bmarketplace\b/i.test(error);
}

function hasDifferentMarketplaceSource(error: string): boolean {
	return /\bdifferent\s+source\b/i.test(error);
}

function marketplaceRootFromPluginSource(source: string | null): string | null {
	if (!source) return null;
	const trimmed = source.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
	const normalized = normalize(trimmed);
	if (!isAbsolute(normalized)) return null;
	return basename(normalized) === ".claude" ? dirname(normalized) : normalized;
}

function marketplaceSourceFromAddError(error: string): string | null {
	const unixPath = error.match(/(?:from|source(?:\s+is)?)[\s:=]+["']?(\/[^"'\r\n;]+)/i)?.[1];
	const windowsPath = error.match(
		/(?:from|source(?:\s+is)?)[\s:=]+["']?([A-Za-z]:[\\/][^"'\r\n;]+)/i,
	)?.[1];
	const candidate = (windowsPath ?? unixPath)?.trim().replace(/[),.]+$/, "") ?? null;
	return marketplaceRootFromPluginSource(candidate);
}

function appendRollback(error: string, rollback: string | null): string {
	return rollback ? `${error}; ${rollback}` : error;
}

export async function removeCodexPlugin(
	opts: { installer?: CodexPluginInstaller; codexHome?: string } = {},
): Promise<RemoveCodexPluginResult> {
	const installer = opts.installer ?? new CodexPluginInstaller(undefined, opts.codexHome);

	if (!(await installer.isCodexAvailable())) {
		return {
			removed: false,
			marketplaceRemoved: false,
			verificationStatus: "codex-unavailable",
			error: "Codex is unavailable; persisted plugin and marketplace absence cannot be verified",
		};
	}
	if (!(await installer.isPluginSupported())) {
		return {
			removed: false,
			marketplaceRemoved: false,
			verificationStatus: "plugins-unsupported",
			error:
				"Codex plugin commands are unsupported; persisted plugin and marketplace absence cannot be verified",
		};
	}

	const removed = await installer.remove();
	const marketplaceRemoved = await installer.marketplaceRemove();
	const state = await detectCodexPluginListState(installer);
	const errors: string[] = [];
	if (!marketplaceRemoved.ok && !isAlreadyAbsentMarketplace(marketplaceRemoved.stderr)) {
		errors.push(
			`codex marketplace removal failed: ${marketplaceRemoved.stderr.trim() || "command did not succeed"}`,
		);
	}
	if (state.status === "unknown") {
		errors.push(
			`codex plugin absence could not be verified: ${state.error ?? "inspection failed"}`,
		);
	} else if (state.installed) {
		errors.push(`codex plugin still installed after removal (${state.status})`);
	}
	return {
		removed: removed.ok,
		marketplaceRemoved: marketplaceRemoved.ok,
		pluginStillInstalled: state.installed,
		...(state.status === "unknown" ? { verificationStatus: state.status } : {}),
		...(errors.length > 0 ? { error: errors.join("; ") } : {}),
	};
}

function isAlreadyAbsentMarketplace(error: string): boolean {
	return /\bnot\s+found\b|\bdoes\s+not\s+exist\b|\bnot\s+registered\b/i.test(error);
}

export async function shouldRefreshCodexPlugin(
	installer: CodexPluginInstaller = new CodexPluginInstaller(),
	options: CodexPluginStateOptions = {},
): Promise<boolean> {
	return (await detectCodexPluginState(installer, options)).shouldRefresh;
}
