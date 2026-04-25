/**
 * PostgresProbe — `SELECT 1` against the injected pool. Used by
 * the /ready endpoint to gate traffic via the reverse proxy.
 *
 * Per Correction A from team-lead, the test seam is the pool's
 * `query` method (mocked with `vi.fn` in tests, real `pg.Pool` in
 * prod). Avoiding pglite here keeps the probe path dependency-free.
 */
import type { ProbeResult } from "./types.js";

/**
 * Subset of `pg.Pool` we actually use. `pg.Pool.query` has many
 * overloads; the structural minimum here lets test stubs satisfy
 * the parameter without reproducing the full `Pool` type, and a
 * real `pg.Pool` already satisfies it via TypeScript's structural
 * typing — no union needed at the parameter site.
 */
export interface PostgresProbeTarget {
  query(text: string): Promise<unknown>;
}

export async function postgresProbe(
  pool: PostgresProbeTarget,
): Promise<ProbeResult> {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
