import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readPrefixedEnv } from "@/shared/environment.js";

describe("readPrefixedEnv", () => {
	let saved: Record<string, string | undefined>;

	// Reflect.deleteProperty rather than `delete`: the linter's suggested fix for
	// `delete` is `= undefined`, which on process.env stores the string "undefined"
	// and would make every one of these assertions lie.
	const unset = (name: string) => Reflect.deleteProperty(process.env, name);
	const restore = (name: string, value: string | undefined) => {
		if (value === undefined) unset(name);
		else process.env[name] = value;
	};

	beforeEach(() => {
		saved = { HK: process.env.HK_TEST_HOME, CK: process.env.CK_TEST_HOME };
		unset("HK_TEST_HOME");
		unset("CK_TEST_HOME");
	});

	afterEach(() => {
		restore("HK_TEST_HOME", saved.HK);
		restore("CK_TEST_HOME", saved.CK);
	});

	it("returns undefined when neither spelling is set", () => {
		expect(readPrefixedEnv("TEST_HOME")).toBeUndefined();
	});

	it("reads the fork's HK_ name", () => {
		process.env.HK_TEST_HOME = "/new";
		expect(readPrefixedEnv("TEST_HOME")).toBe("/new");
	});

	it("still reads upstream's CK_ name, so existing setups keep working", () => {
		process.env.CK_TEST_HOME = "/legacy";
		expect(readPrefixedEnv("TEST_HOME")).toBe("/legacy");
	});

	it("prefers HK_ when both are set", () => {
		process.env.CK_TEST_HOME = "/legacy";
		process.env.HK_TEST_HOME = "/new";
		expect(readPrefixedEnv("TEST_HOME")).toBe("/new");
	});

	it("treats an empty HK_ value as set, not as a reason to fall back", () => {
		// process.env stores "" rather than undefined, and ?? only falls through on
		// null/undefined — pinning this so the precedence rule stays predictable.
		process.env.HK_TEST_HOME = "";
		process.env.CK_TEST_HOME = "/legacy";
		expect(readPrefixedEnv("TEST_HOME")).toBe("");
	});
});
