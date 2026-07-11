import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeProviderState {
	marketplaceSource: string | null;
	installed: boolean;
	enabled: boolean;
	version: string | null;
	failPluginAddOnce?: boolean;
}

export interface FakePluginProviderHarness {
	root: string;
	claudeDir: string;
	codexHome: string;
	extractDir: string;
	stageDir: string;
	userFile: string;
	readClaudeState(): FakeProviderState;
	readCodexState(): FakeProviderState;
	writeClaudeState(state: Partial<FakeProviderState>): void;
	writeCodexState(state: Partial<FakeProviderState>): void;
	cleanup(): void;
}

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"CK_TEST_HOME",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"XDG_CACHE_HOME",
	"PATH",
] as const;

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const config = process.env.CLAUDE_CONFIG_DIR;
const statePath = path.join(config, "fake-claude-provider.json");
const args = process.argv.slice(2);
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const state = read(statePath, { marketplaceSource: null, installed: false, enabled: false, version: null });
const save = () => { fs.mkdirSync(config, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n"); };
const settingsPath = path.join(config, "settings.json");
const syncSettings = () => {
  const settings = read(settingsPath, {}); settings.enabledPlugins = settings.enabledPlugins || {};
  if (state.installed) settings.enabledPlugins["ck@claudekit"] = state.enabled;
  else delete settings.enabledPlugins["ck@claudekit"];
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
};
const syncMarketplace = () => {
  const file = path.join(config, "plugins", "known_marketplaces.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const known = read(file, {}); if (state.marketplaceSource) known.claudekit = { installLocation: state.marketplaceSource }; else delete known.claudekit;
  fs.writeFileSync(file, JSON.stringify(known, null, 2) + "\n");
};
const currentVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(state.marketplaceSource, ".claude", ".claude-plugin", "plugin.json"), "utf8")).version; } catch { return "0.0.0"; } };
const cache = () => { if (state.version) fs.mkdirSync(path.join(config, "plugins", "cache", "claudekit", "ck", state.version), { recursive: true }); };
const ok = (text = "") => { if (text) process.stdout.write(text + "\n"); save(); process.exit(0); };
const fail = (text) => { save(); process.stderr.write(text + "\n"); process.exit(1); };
if (args[0] === "--version") ok("2.1.0");
if (args[0] === "plugin" && args[1] === "--help") ok("plugin marketplace install update uninstall");
if (args[1] === "marketplace" && args[2] === "add") {
  const source = args[3]; if (state.marketplaceSource && state.marketplaceSource !== source) fail("marketplace already registered from different source");
  state.marketplaceSource = source; syncMarketplace(); ok();
}
if (args[1] === "marketplace" && args[2] === "update") fail("marketplace source cannot update in place");
if (args[1] === "marketplace" && args[2] === "remove") { state.marketplaceSource = null; syncMarketplace(); ok(); }
if (args[1] === "install") { state.installed = true; state.enabled = true; state.version = currentVersion(); syncSettings(); cache(); ok(); }
if (args[1] === "enable") { state.installed = true; state.enabled = true; syncSettings(); ok(); }
if (args[1] === "update") { state.installed = true; state.version = currentVersion(); syncSettings(); cache(); ok(); }
if (args[1] === "uninstall") { state.installed = false; state.enabled = false; syncSettings(); ok(); }
if (args[1] === "list") ok(state.installed ? "ck@claudekit\n  " + (state.enabled ? "enabled" : "disabled") + "\n" : "No plugins installed");
fail("unsupported fake claude command: " + args.join(" "));
`;

const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const statePath = path.join(home, "fake-codex-provider.json");
const args = process.argv.slice(2);
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const state = read(statePath, { marketplaceSource: null, installed: false, enabled: false, version: null });
const save = () => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n"); };
const currentVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(state.marketplaceSource, ".claude", ".codex-plugin", "plugin.json"), "utf8")).version; } catch { return "0.0.0"; } };
const entry = () => ({ pluginId: "ck@claudekit", installed: state.installed, enabled: state.enabled, version: state.version, marketplace: "claudekit", source: state.marketplaceSource ? path.join(state.marketplaceSource, ".claude") : null });
const ok = (text = "") => { if (text) process.stdout.write(text + "\n"); save(); process.exit(0); };
const fail = (text) => { save(); process.stderr.write(text + "\n"); process.exit(1); };
if (args[0] === "--version") ok("codex 1.0.0");
if (args[0] === "plugin" && args[1] === "--help") ok("plugin marketplace add remove list");
if (args[1] === "marketplace" && args[2] === "add") {
  const source = args[3]; if (state.marketplaceSource && state.marketplaceSource !== source) fail("marketplace already registered from different source");
  state.marketplaceSource = source; ok();
}
if (args[1] === "marketplace" && args[2] === "remove") { if (!state.marketplaceSource) fail("marketplace not found"); state.marketplaceSource = null; ok(); }
if (args[1] === "add") {
  if (state.failPluginAddOnce) { state.failPluginAddOnce = false; fail("injected plugin add failure"); }
  state.installed = true; state.enabled = true; state.version = currentVersion(); ok();
}
if (args[1] === "remove") { if (!state.installed) fail("plugin not found"); state.installed = false; state.enabled = false; ok(); }
if (args[1] === "list" && args[2] === "--json") ok(JSON.stringify(state.installed ? [entry()] : []));
if (args[1] === "list") ok(state.installed ? "ck@claudekit installed " + (state.enabled ? "enabled " : "disabled ") + (state.version || "") : "No plugins installed");
fail("unsupported fake codex command: " + args.join(" "));
`;

function readState(path: string): FakeProviderState {
	return JSON.parse(readFileSync(path, "utf8")) as FakeProviderState;
}

function mergeState(path: string, patch: Partial<FakeProviderState>): FakeProviderState {
	let current: FakeProviderState = {
		marketplaceSource: null,
		installed: false,
		enabled: false,
		version: null,
	};
	try {
		current = readState(path);
	} catch {}
	const next = { ...current, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

function syncClaudeFilesystem(claudeDir: string, state: FakeProviderState): void {
	const settingsPath = join(claudeDir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {}
	const enabledPlugins =
		typeof settings.enabledPlugins === "object" && settings.enabledPlugins !== null
			? (settings.enabledPlugins as Record<string, boolean>)
			: {};
	const otherPlugins = Object.fromEntries(
		Object.entries(enabledPlugins).filter(([name]) => name !== "ck@claudekit"),
	);
	settings.enabledPlugins = state.installed
		? { ...otherPlugins, "ck@claudekit": state.enabled }
		: otherPlugins;
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

	const marketplacePath = join(claudeDir, "plugins", "known_marketplaces.json");
	mkdirSync(dirname(marketplacePath), { recursive: true });
	const marketplaces: Record<string, unknown> = {};
	if (state.marketplaceSource) {
		marketplaces.claudekit = { installLocation: state.marketplaceSource };
	}
	writeFileSync(marketplacePath, `${JSON.stringify(marketplaces, null, 2)}\n`, "utf8");

	if (state.version) {
		mkdirSync(join(claudeDir, "plugins", "cache", "claudekit", "ck", state.version), {
			recursive: true,
		});
	}
}

export function createFakePluginProviderHarness(): FakePluginProviderHarness {
	const root = mkdtempSync(join(tmpdir(), "ck-plugin-lifecycle-"));
	const claudeDir = join(root, ".claude");
	const codexHome = join(root, ".codex");
	const extractDir = join(root, "extract");
	const stageDir = join(root, ".cache", "claude", "ck-plugin-source");
	const binDir = join(root, "bin");
	const userFile = join(claudeDir, "skills", "personal", "SKILL.md");
	const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

	for (const directory of [claudeDir, codexHome, binDir, join(extractDir, ".claude")]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const key of ["HOME", "USERPROFILE", "CK_TEST_HOME"] as const) process.env[key] = root;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	process.env.CODEX_HOME = codexHome;
	process.env.APPDATA = join(root, "AppData", "Roaming");
	process.env.LOCALAPPDATA = join(root, "AppData", "Local");
	process.env.XDG_CACHE_HOME = join(root, ".cache");
	process.env.PATH = `${binDir}:${previousEnv.PATH ?? ""}`;

	writeFileSync(join(binDir, "claude"), FAKE_CLAUDE, "utf8");
	writeFileSync(join(binDir, "codex"), FAKE_CODEX, "utf8");
	chmodSync(join(binDir, "claude"), 0o755);
	chmodSync(join(binDir, "codex"), 0o755);

	mkdirSync(join(extractDir, ".claude", ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(extractDir, ".claude", ".claude-plugin", "plugin.json"),
		`${JSON.stringify({ name: "ck", version: "2.20.1" })}\n`,
		"utf8",
	);
	mkdirSync(join(extractDir, ".claude", ".codex-plugin"), { recursive: true });
	writeFileSync(
		join(extractDir, ".claude", ".codex-plugin", "plugin.json"),
		`${JSON.stringify({ name: "ck", version: "2.20.1" })}\n`,
		"utf8",
	);
	mkdirSync(join(extractDir, ".claude", "skills", "cook"), { recursive: true });
	writeFileSync(
		join(extractDir, ".claude", "skills", "cook", "SKILL.md"),
		"---\nname: cook\n---\nBody\n",
		"utf8",
	);
	mkdirSync(dirname(userFile), { recursive: true });
	writeFileSync(userFile, "user-owned content\n", "utf8");

	const claudeStatePath = join(claudeDir, "fake-claude-provider.json");
	const codexStatePath = join(codexHome, "fake-codex-provider.json");

	return {
		root,
		claudeDir,
		codexHome,
		extractDir,
		stageDir,
		userFile,
		readClaudeState: () => readState(claudeStatePath),
		readCodexState: () => readState(codexStatePath),
		writeClaudeState: (state) => {
			syncClaudeFilesystem(claudeDir, mergeState(claudeStatePath, state));
		},
		writeCodexState: (state) => {
			mergeState(codexStatePath, state);
		},
		cleanup: () => {
			for (const key of ENV_KEYS) {
				const previous = previousEnv[key];
				if (previous === undefined) delete process.env[key];
				else process.env[key] = previous;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}
