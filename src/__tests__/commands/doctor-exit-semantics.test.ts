import { describe, expect, test } from "bun:test";
import { hasActionableDoctorFindings } from "@/commands/doctor.js";

describe("doctor check-only exit semantics", () => {
	test.each([
		[{ failed: 0, warnings: 0 }, false],
		[{ failed: 1, warnings: 0 }, true],
		[{ failed: 0, warnings: 1 }, true],
		[{ failed: 1, warnings: 1 }, true],
	] as const)("maps summary %p to actionable=%p", (summary, expected) => {
		expect(hasActionableDoctorFindings(summary)).toBe(expected);
	});
});
