/**
 * Asana `seed()` primitive (PR-Z2, phase-a appendix #12 G2).
 *
 * Why this file exists. The Asana adapter is webhook-mode —
 * `scan()` returns `{ documents: [], nextCursor: null }` in
 * the default modes, and `snapshotMode='periodic'` returns
 * one snapshot doc per project. Neither path surfaces the
 * EXISTING tasks in a project at binding-create time. The
 * webhook stream only catches events from the moment the
 * binding is registered forward, so a brand-new domain
 * looking at an Asana project with 50 tasks would see
 * exactly 0 ingestion-intake rows until someone touched a
 * task.
 *
 * The seed primitive backfills that gap: one
 * `SourceChangedDocument` per task in the bound project,
 * paginated via the existing `AsanaClient.fetchProjectSnapshot`
 * helper (which already handles 429-aware backoff, 5xx retry,
 * and pagination over `next_page.uri`). After the seed
 * completes, the steady-state webhook + scanner combination
 * picks up real-time changes.
 *
 * Doc shape mirrors the webhook path's `parseEvents` output:
 *   - `sourceDocId` = `task-<gid>:seeded`. The `:seeded`
 *     discriminator keeps seed rows distinct from event-driven
 *     rows (`<gid>:<action>`) in the intake table so a future
 *     webhook delivery for the same task doesn't dedupe-eat
 *     the seed row.
 *   - `sourceRevision` = the task's `modified_at` ISO string —
 *     a future seed re-run with no source mutation is intake-
 *     dedupe no-op via the UNIQUE(binding_id, source_doc_id,
 *     source_revision) constraint.
 *   - `sourceRef` = `asana:task/<gid>` (matches the webhook
 *     shape).
 *   - `contentBytes` = the task row serialized as JSON. The
 *     Compilation Worker accepts inline JSON the same way it
 *     accepts inline event JSON from the webhook path.
 *
 * Cursor handoff. Returns a sentinel `seeded:<ISO>` string
 * rather than `null`. The Scanner uses cursor-non-null as the
 * "this binding is seeded" flag, so a literal-null cursor
 * would cause every subsequent tick to re-route to seed()
 * and re-pull every task. The sentinel is opaque to scan()
 * — Asana's scan() ignores its input cursor anyway (it's
 * webhook-driven for incremental, returning
 * `{ documents: [], nextCursor: null }` in default modes /
 * one snapshot per project in periodic mode). The sentinel
 * format is deliberately human-readable so the operator can
 * read `sources_bindings.last_scan_cursor` and understand
 * when the binding was seeded.
 */
export const ASANA_SEED_CURSOR_PREFIX = "asana-seeded:" as const;
import type {
  SourceChangedDocument,
  SourceSeedArgs,
  SourceSeedResult,
} from "@opencoo/shared/source-adapter";

import type { AsanaClient, AsanaTaskRow } from "./asana-client.js";

export interface RunAsanaSeedArgs {
  readonly seedArgs: SourceSeedArgs;
  readonly asanaClient: AsanaClient;
  /** One or more Asana project GIDs to seed from. v0.1 always
   *  passes one or `monitoredProjectGids`-many — the seed
   *  iterates every entry. */
  readonly projectGids: readonly string[];
  readonly now: () => Date;
}

/** Per-task content size ceiling — mirrors the scan-path
 *  + webhook-path 1 MiB cap. */
const ONE_MIB = 1024 * 1024;

/**
 * Serialize one task row + emit a `SourceChangedDocument`.
 * Tasks larger than 1 MiB are silently skipped — they'd
 * overflow the Compilation Worker's prompt budget anyway and
 * the same shape applies on the webhook side.
 */
function buildTaskDocument(
  task: AsanaTaskRow,
  fetchedAt: Date,
): SourceChangedDocument | null {
  const contentBytes = Buffer.from(JSON.stringify(task), "utf8");
  if (contentBytes.length > ONE_MIB) return null;
  return {
    sourceDocId: `task-${task.gid}:seeded`,
    sourceRevision: task.modified_at,
    sourceRef: `asana:task/${task.gid}`,
    fetchedAt,
    contentBytes,
  };
}

/**
 * Implementation of the Asana `seed()` primitive. Iterates
 * each project GID, snapshots its tasks via the existing
 * `AsanaClient.fetchProjectSnapshot`, and emits one
 * `SourceChangedDocument` per task. A failure on one project
 * is logged + skipped — the seed continues to subsequent
 * projects so a single transient 5xx doesn't poison the
 * whole bootstrap.
 */
export async function runAsanaSeed(
  args: RunAsanaSeedArgs,
): Promise<SourceSeedResult> {
  void args.seedArgs; // currently unused; reserved for future cadence hooks
  const documents: SourceChangedDocument[] = [];
  const fetchedAt = args.now();

  for (const projectGid of args.projectGids) {
    let snapshot;
    try {
      snapshot = await args.asanaClient.fetchProjectSnapshot(projectGid);
    } catch (err) {
      // Fail-open per the existing client's policy (mirrors
      // the snapshot fetch fail-open in adapter.ts's
      // enrichEvents). A subsequent seed re-run after the
      // upstream recovers picks up where we left off because
      // intake-dedupe handles partial-seed replay cleanly.
      console.warn("source-asana: seed() snapshot fetch failed for project", {
        projectGid,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const task of snapshot.snapshot) {
      const doc = buildTaskDocument(task, fetchedAt);
      if (doc !== null) documents.push(doc);
    }
  }

  // Asana is webhook-driven for incremental; we synthesize a
  // sentinel cursor so the Scanner's cursor-non-null flag
  // marks the binding as seeded and the next tick goes
  // through `scan()` (a no-op for default modes, a fresh
  // snapshot for periodic mode). See the file header for the
  // rationale.
  return {
    documents,
    cursor: `${ASANA_SEED_CURSOR_PREFIX}${fetchedAt.toISOString()}`,
  };
}
