// Negative-case fixture for opencoo/no-cross-engine-import.
// Lives outside packages/engine-ingestion/** so the rule's path-based
// detection would miss it; eslint.config.js passes `appliesTo: 'ingestion'`
// in the fixtures block to force the rule to treat this file as engine-ingestion.
// `pnpm lint:fixtures` MUST fail with exactly this rule ID.

import { foo } from "@opencoo/engine-self-operating/harness";

export const _ = foo;
