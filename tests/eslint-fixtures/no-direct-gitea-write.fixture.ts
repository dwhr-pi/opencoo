// Negative-case fixture for opencoo/no-direct-gitea-write.
// Importing a Gitea client outside packages/shared/wiki-write/** must fail.

import { createClient } from "@opencoo/gitea-client";

export const _ = createClient;
