import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";

// typescript-eslint's RuleTester does not autodetect vitest — wire its
// TestFramework hooks into vitest's globals so `ruleTester.run()` drops
// each case into an `it()` inside a `describe()`.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
