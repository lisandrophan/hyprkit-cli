import { describe, expect, test } from "bun:test";
import {
	CodexPluginInstaller,
	type CodexRunResult,
	detectCodexPluginState,
	installCodexPlugin,
	prepareCodexPlugin,
	removeCodexPlugin,
	resolveCodexExecutable,
	resolveCodexExecutableCandidates,
	shouldRefreshCodexPlugin,
	shouldRunCodexInShell,
} from "@/domains/installation/plugin/codex-plugin-installer.js";

function ok(stdout = "", stderr = ""): CodexRunResult {
	return { ok: true, stdout, stderr, code: 0 };
}

function fail(stderr = "failed"): CodexRunResult {
	return { ok: false, stdout: "", stderr, code: 1 };
}

describe("CodexPluginInstaller", () => {
	test("resolves Codex without a shell on Windows", () => {
		expect(resolveCodexExecutable("win32")).toBe("codex");
		expect(shouldRunCodexInShell("win32")).toBe(false);
		expect(resolveCodexExecutable("linux")).toBe("codex");
		expect(shouldRunCodexInShell("linux")).toBe(false);
	});

	test("falls back to the Windows codex.cmd shim without shell mode", () => {
		expect(resolveCodexExecutableCandidates("win32")).toEqual([
			{ command: "codex", argsPrefix: [] },
			{ command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "codex.cmd"] },
		]);
		expect(resolveCodexExecutableCandidates("linux")).toEqual([
			{ command: "codex", argsPrefix: [] },
		]);
		expect(shouldRunCodexInShell("win32")).toBe(false);
	});

	test("installs ck@claudekit through a local marketplace", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/plugin-source") return ok();
			if (args.join(" ") === "plugin add ck@claudekit") return ok();
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
							},
						],
					}),
				);
			}
			return fail(`unexpected command: ${args.join(" ")}`);
		});

		const result = await installCodexPlugin({
			pluginSourceDir: "/tmp/plugin-source",
			installer,
		});

		expect(result).toEqual({ action: "installed", pluginVerified: true });
		expect(calls).toEqual([
			["--version"],
			["plugin", "--help"],
			["plugin", "marketplace", "add", "/tmp/plugin-source"],
			["plugin", "add", "ck@claudekit"],
			["plugin", "list", "--json"],
		]);
	});

	test("fresh preparation rolls back newly added plugin and marketplace", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin marketplace add /tmp/source") return ok();
			if (command === "plugin add ck@claudekit") return ok();
			if (command === "plugin list --json") {
				return ok(JSON.stringify({ installed: [{ pluginId: "ck@claudekit", enabled: true }] }));
			}
			if (command === "plugin remove ck@claudekit") return ok();
			if (command === "plugin marketplace remove claudekit") return ok();
			return fail(`unexpected command: ${command}`);
		});

		const preparation = await prepareCodexPlugin({
			pluginSourceDir: "/tmp/source",
			installer,
		});
		expect(preparation.result).toEqual({ action: "installed", pluginVerified: true });
		await expect(preparation.rollback()).resolves.toEqual({
			ok: true,
			detail: "removed newly prepared Codex plugin and marketplace",
		});
		expect(calls.slice(-2)).toEqual([
			["plugin", "remove", "ck@claudekit"],
			["plugin", "marketplace", "remove", "claudekit"],
		]);
	});

	test("verifies installed plugin from current Codex text list output when JSON is unsupported", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.135.0");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/plugin-source") return ok();
			if (args.join(" ") === "plugin add ck@claudekit") return ok();
			if (args.join(" ") === "plugin list --json") {
				return fail("error: unexpected argument '--json' found");
			}
			if (args.join(" ") === "plugin list") {
				return ok(`Marketplace \`claudekit\`

PLUGIN        STATUS              VERSION        PATH
ck@claudekit  installed, enabled  2.20.1-beta.6  C:\\\\Users\\\\kaidu\\\\.codex\\\\plugins\\\\ck
`);
			}
			return fail(`unexpected command: ${args.join(" ")}`);
		});

		const result = await installCodexPlugin({
			pluginSourceDir: "/tmp/plugin-source",
			installer,
		});

		expect(result).toEqual({ action: "installed", pluginVerified: true });
		expect(calls).toEqual([
			["--version"],
			["plugin", "--help"],
			["plugin", "marketplace", "add", "/tmp/plugin-source"],
			["plugin", "add", "ck@claudekit"],
			["plugin", "list", "--json"],
			["plugin", "list"],
		]);
	});

	test("does not verify text list output unless ck is installed and enabled", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.135.0");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return fail("error: unexpected argument '--json' found");
			}
			if (args.join(" ") === "plugin list") {
				return ok(`PLUGIN        STATUS
ck@claudekit  installed, disabled
other@market  installed, enabled
`);
			}
			return fail("unexpected");
		});

		await expect(shouldRefreshCodexPlugin(installer)).resolves.toBe(true);
	});

	test("skips when Codex lacks plugin support", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.142.0");
			if (args.join(" ") === "plugin --help") return fail("unknown command");
			return fail("should not install");
		});

		await expect(
			installCodexPlugin({ pluginSourceDir: "/tmp/source", installer }),
		).resolves.toEqual({
			action: "skipped-codex-unsupported",
			pluginVerified: false,
		});
	});

	test("reports marketplace add failures", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/source") return fail("bad marketplace");
			return fail("should not install");
		});

		const result = await installCodexPlugin({ pluginSourceDir: "/tmp/source", installer });

		expect(result.action).toBe("install-failed");
		expect(result.pluginVerified).toBe(false);
		expect(result.error).toContain("bad marketplace");
	});

	test("replaces stale marketplace source even when the plugin is disabled", async () => {
		const calls: string[][] = [];
		let addAttempts = 0;
		let listAttempts = 0;
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/source") {
				addAttempts++;
				return addAttempts === 1
					? fail("marketplace 'claudekit' is already added from a different source")
					: ok();
			}
			if (args.join(" ") === "plugin marketplace remove claudekit") return ok();
			if (args.join(" ") === "plugin add ck@claudekit") return ok();
			if (args.join(" ") === "plugin list --json") {
				listAttempts++;
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: listAttempts !== 1,
								source: {
									source: "local",
									path: listAttempts === 1 ? "/tmp/old-source/.claude" : "/tmp/source/.claude",
								},
							},
						],
					}),
				);
			}
			return fail(`unexpected command: ${args.join(" ")}`);
		});

		await expect(
			installCodexPlugin({ pluginSourceDir: "/tmp/source", installer }),
		).resolves.toEqual({ action: "installed", pluginVerified: true });
		expect(calls).toEqual([
			["--version"],
			["plugin", "--help"],
			["plugin", "marketplace", "add", "/tmp/source"],
			["plugin", "list", "--json"],
			["plugin", "marketplace", "remove", "claudekit"],
			["plugin", "marketplace", "add", "/tmp/source"],
			["plugin", "add", "ck@claudekit"],
			["plugin", "list", "--json"],
		]);
	});

	test("keeps a healthy already-registered marketplace without replacement", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/source") {
				return fail("marketplace 'claudekit' is already added");
			}
			if (args.join(" ") === "plugin add ck@claudekit") return ok();
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								source: { source: "local", path: "/tmp/source/.claude" },
							},
						],
					}),
				);
			}
			return fail(`unexpected command: ${args.join(" ")}`);
		});

		await expect(
			installCodexPlugin({ pluginSourceDir: "/tmp/source", installer }),
		).resolves.toEqual({ action: "installed", pluginVerified: true });
		expect(calls).not.toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
	});

	test("same-source preparation rollback reloads restored stage content", async () => {
		const calls: string[][] = [];
		let marketplaceAdds = 0;
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin marketplace add /tmp/source") {
				marketplaceAdds++;
				return marketplaceAdds === 1 ? fail("marketplace 'claudekit' is already added") : ok();
			}
			if (command === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								source: "/tmp/source/.claude",
							},
						],
					}),
				);
			}
			if (command === "plugin add ck@claudekit") return ok();
			if (command === "plugin remove ck@claudekit") return ok();
			if (command === "plugin marketplace remove claudekit") return ok();
			return fail(`unexpected command: ${command}`);
		});

		const preparation = await prepareCodexPlugin({
			pluginSourceDir: "/tmp/source",
			installer,
		});
		await expect(preparation.rollback()).resolves.toEqual({
			ok: true,
			detail: "reloaded previous Codex marketplace and plugin state",
		});
		expect(calls.slice(-4)).toEqual([
			["plugin", "remove", "ck@claudekit"],
			["plugin", "marketplace", "remove", "claudekit"],
			["plugin", "marketplace", "add", "/tmp/source"],
			["plugin", "add", "ck@claudekit"],
		]);
	});

	test("restores stale marketplace and plugin state when replacement fails", async () => {
		const calls: string[][] = [];
		let newSourceAttempts = 0;
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/new-source") {
				newSourceAttempts++;
				return newSourceAttempts === 1
					? fail("marketplace 'claudekit' is already added from a different source")
					: fail("replacement failed");
			}
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								source: { source: "local", path: "/tmp/old-source/.claude" },
							},
						],
					}),
				);
			}
			if (args.join(" ") === "plugin marketplace remove claudekit") return ok();
			if (args.join(" ") === "plugin marketplace add /tmp/old-source") return ok();
			if (args.join(" ") === "plugin add ck@claudekit") return ok();
			return fail(`unexpected command: ${args.join(" ")}`);
		});

		const result = await installCodexPlugin({
			pluginSourceDir: "/tmp/new-source",
			installer,
		});
		expect(result).toMatchObject({ action: "install-failed", pluginVerified: false });
		expect(result.error).toContain("replacement failed");
		expect(result.error).toContain("restored previous marketplace and plugin state");
		expect(calls).toContainEqual(["plugin", "marketplace", "add", "/tmp/old-source"]);
		expect(calls).toContainEqual(["plugin", "add", "ck@claudekit"]);
	});

	test("does not destroy stale registration when its prior source is not recoverable", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin marketplace add /tmp/new-source") {
				return fail("marketplace 'claudekit' is already added from a different source");
			}
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								source: { source: "local", path: ".claude" },
							},
						],
					}),
				);
			}
			return fail(`unexpected command: ${args.join(" ")}`);
		});
		const result = await installCodexPlugin({
			pluginSourceDir: "/tmp/new-source",
			installer,
		});
		expect(result).toMatchObject({ action: "install-failed", pluginVerified: false });
		expect(result.error).toContain("previous source could not be determined safely");
		expect(calls).not.toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
	});

	test("recovers malformed Codex inspection when add reports a safe previous source", async () => {
		const calls: string[][] = [];
		let newSourceAdds = 0;
		let jsonLists = 0;
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin marketplace add /tmp/new-source") {
				newSourceAdds++;
				return newSourceAdds === 1
					? fail("marketplace already registered; source: /tmp/old-source")
					: ok();
			}
			if (command === "plugin list --json") {
				jsonLists++;
				return jsonLists === 1
					? fail("malformed marketplace state")
					: ok(
							JSON.stringify({
								installed: [
									{
										pluginId: "ck@claudekit",
										installed: true,
										enabled: true,
										source: "/tmp/new-source/.claude",
									},
								],
							}),
						);
			}
			if (command === "plugin list") return fail("malformed marketplace state");
			if (command === "plugin marketplace remove claudekit") return ok();
			if (command === "plugin add ck@claudekit") return ok();
			return fail(`unexpected command: ${command}`);
		});

		await expect(
			installCodexPlugin({ pluginSourceDir: "/tmp/new-source", installer }),
		).resolves.toEqual({ action: "installed", pluginVerified: true });
		expect(calls).toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
		expect(calls).toContainEqual(["plugin", "marketplace", "add", "/tmp/new-source"]);
	});

	test("keeps irrecoverable unknown Codex registration non-destructive and explicit", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin marketplace add /tmp/new-source") {
				return fail("marketplace already registered from a different source");
			}
			if (command === "plugin list --json" || command === "plugin list") {
				return fail("malformed marketplace state");
			}
			return fail(`unexpected command: ${command}`);
		});

		const result = await installCodexPlugin({
			pluginSourceDir: "/tmp/new-source",
			installer,
		});
		expect(result).toMatchObject({ action: "install-failed", pluginVerified: false });
		expect(result.error).toContain("irrecoverably unknown");
		expect(calls).not.toContainEqual(["plugin", "marketplace", "remove", "claudekit"]);
	});

	test("asks update self-heal to refresh only when supported Codex is missing ck", async () => {
		const installed = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [{ pluginId: "ck@claudekit", installed: true, enabled: true }],
					}),
				);
			}
			return fail("unexpected");
		});
		await expect(shouldRefreshCodexPlugin(installed)).resolves.toBe(false);

		const missing = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") return ok(JSON.stringify({ installed: [] }));
			return fail("unexpected");
		});
		await expect(shouldRefreshCodexPlugin(missing)).resolves.toBe(true);
	});

	test("reports supported Codex plugin state as structured current, disabled, missing, or stale", async () => {
		const stale = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								version: "2.20.1-beta.6",
								marketplace: "claudekit",
							},
						],
					}),
				);
			}
			return fail("unexpected");
		});

		await expect(
			detectCodexPluginState(stale, { expectedVersion: "2.20.1-beta.7" }),
		).resolves.toMatchObject({
			status: "installed-stale-version",
			pluginId: "ck@claudekit",
			enabled: true,
			installedVersion: "2.20.1-beta.6",
			expectedVersion: "2.20.1-beta.7",
			shouldRefresh: true,
		});

		const disabled = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: false,
								version: "2.20.1-beta.7",
							},
						],
					}),
				);
			}
			return fail("unexpected");
		});

		await expect(
			detectCodexPluginState(disabled, { expectedVersion: "2.20.1-beta.7" }),
		).resolves.toMatchObject({
			status: "disabled",
			shouldRefresh: true,
		});
	});

	test("expected Codex source and version cannot pass when inspection omits them", async () => {
		const stateWith = (entry: Record<string, unknown>) =>
			new CodexPluginInstaller(async (args) => {
				if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
				if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
				if (args.join(" ") === "plugin list --json") {
					return ok(JSON.stringify({ installed: [{ pluginId: "ck@claudekit", ...entry }] }));
				}
				return fail("unexpected");
			});

		await expect(
			detectCodexPluginState(
				stateWith({
					installed: true,
					enabled: true,
					version: "2.20.1",
					marketplace: "claudekit",
				}),
				{ expectedSource: "/expected/.claude" },
			),
		).resolves.toMatchObject({ status: "installed-stale-source", shouldRefresh: true });

		await expect(
			detectCodexPluginState(
				stateWith({
					installed: true,
					enabled: true,
					marketplace: "claudekit",
					source: "/expected/.claude",
				}),
				{ expectedVersion: "2.20.1", expectedSource: "/expected/.claude" },
			),
		).resolves.toMatchObject({ status: "installed-stale-version", shouldRefresh: true });

		await expect(
			detectCodexPluginState(
				stateWith({
					installed: true,
					enabled: false,
					version: "2.20.1",
					marketplace: "claudekit",
					source: "/old/.claude",
				}),
				{ expectedVersion: "2.20.1", expectedSource: "/expected/.claude" },
			),
		).resolves.toMatchObject({ status: "installed-stale-source", shouldRefresh: true });
	});

	test("self-heal refreshes stale Codex versions instead of treating enabled as healthy", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								version: "2.20.1-beta.6",
							},
						],
					}),
				);
			}
			return fail("unexpected");
		});

		await expect(
			shouldRefreshCodexPlugin(installer, { expectedVersion: "2.20.1-beta.7" }),
		).resolves.toBe(true);
	});

	test("removes ck@claudekit and the marketplace when Codex plugins are supported", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin remove ck@claudekit") return ok();
			if (args.join(" ") === "plugin marketplace remove claudekit") return ok();
			if (args.join(" ") === "plugin list --json") return ok(JSON.stringify({ installed: [] }));
			return fail(`unexpected command: ${args.join(" ")}`);
		});

		await expect(removeCodexPlugin({ installer })).resolves.toEqual({
			removed: true,
			marketplaceRemoved: true,
			pluginStillInstalled: false,
		});
		expect(calls).toEqual([
			["--version"],
			["plugin", "--help"],
			["plugin", "remove", "ck@claudekit"],
			["plugin", "marketplace", "remove", "claudekit"],
			["plugin", "list", "--json"],
		]);
	});

	test("parses object-shaped Codex source and reports stale marketplace source", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								version: "2.20.1-beta.7",
								marketplace: "claudekit",
								source: { source: "local", path: "/old/ck-plugin-source" },
							},
						],
					}),
				);
			}
			return fail("unexpected");
		});

		await expect(
			detectCodexPluginState(installer, { expectedSource: "/new/ck-plugin-source" }),
		).resolves.toMatchObject({
			status: "installed-stale-source",
			source: "/old/ck-plugin-source",
			expectedSource: "/new/ck-plugin-source",
			shouldRefresh: true,
		});
	});

	test("treats equivalent local source paths as current", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			if (args.join(" ") === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (args.join(" ") === "plugin --help") return ok("plugin marketplace add");
			if (args.join(" ") === "plugin list --json") {
				return ok(
					JSON.stringify({
						installed: [
							{
								pluginId: "ck@claudekit",
								installed: true,
								enabled: true,
								version: "2.20.1-beta.7",
								marketplace: "claudekit",
								source: { source: "local", path: "/tmp/ck-plugin-source/.claude" },
							},
						],
					}),
				);
			}
			return fail("unexpected");
		});

		await expect(
			detectCodexPluginState(installer, {
				expectedSource: "/tmp/../tmp/ck-plugin-source/.claude",
			}),
		).resolves.toMatchObject({
			status: "installed-current",
			shouldRefresh: false,
		});
	});

	test("marketplace removal failure prevents verified cleanup success", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin remove ck@claudekit") return ok();
			if (command === "plugin marketplace remove claudekit") return fail("registry locked");
			if (command === "plugin list --json") return ok(JSON.stringify({ installed: [] }));
			return fail(`unexpected command: ${command}`);
		});

		await expect(removeCodexPlugin({ installer })).resolves.toMatchObject({
			removed: true,
			marketplaceRemoved: false,
			pluginStillInstalled: false,
			error: "codex marketplace removal failed: registry locked",
		});
	});

	test("repeated cleanup treats an already-absent marketplace as an idempotent no-op", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin remove ck@claudekit") return fail("plugin not found");
			if (command === "plugin marketplace remove claudekit") {
				return fail("marketplace not found");
			}
			if (command === "plugin list --json") return ok(JSON.stringify({ installed: [] }));
			return fail(`unexpected command: ${command}`);
		});

		await expect(removeCodexPlugin({ installer })).resolves.toMatchObject({
			removed: false,
			marketplaceRemoved: false,
			pluginStillInstalled: false,
		});
		expect((await removeCodexPlugin({ installer })).error).toBeUndefined();
	});

	test("unknown post-removal state is an explicit verification failure", async () => {
		const installer = new CodexPluginInstaller(async (args) => {
			const command = args.join(" ");
			if (command === "--version") return ok("codex-cli 0.143.0-alpha.14");
			if (command === "plugin --help") return ok("plugin marketplace add");
			if (command === "plugin remove ck@claudekit") return ok();
			if (command === "plugin marketplace remove claudekit") return ok();
			if (command === "plugin list --json" || command === "plugin list") {
				return fail("inspection failed");
			}
			return fail(`unexpected command: ${command}`);
		});

		await expect(removeCodexPlugin({ installer })).resolves.toMatchObject({
			removed: true,
			marketplaceRemoved: true,
			verificationStatus: "unknown",
			error: "codex plugin absence could not be verified: inspection failed",
		});
	});

	test("skips Codex plugin removal when Codex has no plugin support", async () => {
		const calls: string[][] = [];
		const installer = new CodexPluginInstaller(async (args) => {
			calls.push(args);
			if (args.join(" ") === "--version") return ok("codex-cli 0.142.0");
			if (args.join(" ") === "plugin --help") return fail("unknown command");
			return fail("should not remove");
		});

		await expect(removeCodexPlugin({ installer })).resolves.toEqual({
			removed: false,
			marketplaceRemoved: false,
			verificationStatus: "plugins-unsupported",
			error:
				"Codex plugin commands are unsupported; persisted plugin and marketplace absence cannot be verified",
		});
		expect(calls).toEqual([["--version"], ["plugin", "--help"]]);
	});
});
