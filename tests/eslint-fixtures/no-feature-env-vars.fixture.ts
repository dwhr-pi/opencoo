// Negative-case fixture for opencoo/no-feature-env-vars.
// Both keys are outside the .env.example allow-list; the rule must flag
// each process.env.<X> access separately.

const host = process.env.GITEA_URL;
const tier = process.env.LLM_TIER;

export const _ = { host, tier };
