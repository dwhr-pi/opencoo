import { expect, test } from "vitest";

// Sanity check: the vitest harness is wired. Real tests land with PR 01.
test("vitest harness wired", () => {
  expect(1 + 1).toBe(2);
});
