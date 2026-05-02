/**
 * Review Dashboard — lint findings sub-view.
 *
 * Consumes `GET /api/admin/lint-findings` (existing endpoint).
 * Acknowledges individual findings via a POST to the audit endpoint
 * using the `lint_finding.acknowledge` audit verb (already in the
 * server-side allowlist per PR #28).
 *
 * The acknowledge endpoint shape is:
 *   POST /api/admin/lint-findings/:runId/acknowledge
 *   Body: { findingId: string; note?: string }
 *   where findingId = `${kind}:${path}`
 *
 * Security: all state-changing actions go through existing audited
 * endpoints. CSRF token is injected by fetchAdmin automatically.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../../components/Btn.js";
import { NoticeRow } from "../../components/NoticeRow.js";
import { fetchAdmin, fetchOptsFor } from "../../lib/api.js";
import { ReviewTableHeader } from "./ReviewTableHeader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LintFinding {
  readonly kind: string;
  readonly path: string;
  readonly detail: string;
}

interface LintRun {
  readonly runId: string;
  readonly instanceId: string | null;
  readonly endedAt: string | null;
  readonly findings: readonly LintFinding[];
}

interface LintFindingsResponse {
  readonly runs: readonly LintRun[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface LintFindingsProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LintFindings(props: LintFindingsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<readonly LintRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [ackErrors, setAckErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<LintFindingsResponse>(
          "/api/admin/lint-findings",
          fetchOptsFor(props.fetchImpl),
        );
        setRuns(r.runs);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (runs === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;

  const allFindings = runs.flatMap((run) =>
    run.findings.map((f) => ({ ...f, runId: run.runId, endedAt: run.endedAt })),
  );

  if (allFindings.length === 0) {
    return <NoticeRow tone="muted">{t("review.lintFindings.empty")}</NoticeRow>;
  }

  const ackKey = (runId: string, kind: string, path: string): string =>
    `${runId}:${kind}:${path}`;

  const handleAck = async (runId: string, kind: string, path: string): Promise<void> => {
    const key = ackKey(runId, kind, path);
    try {
      await fetchAdmin(
        `/api/admin/lint-findings/${runId}/acknowledge`,
        {
          method: "POST",
          body: { findingId: `${kind}:${path}` },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      setAcknowledged((prev) => new Set([...prev, key]));
    } catch {
      setAckErrors((prev) => ({ ...prev, [key]: t("common.error") }));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
        }}
      >
        <ReviewTableHeader
          columns={[
            t("review.lintFindings.columns.kind"),
            t("review.lintFindings.columns.path"),
            t("review.lintFindings.columns.detail"),
            t("review.lintFindings.columns.actions"),
          ]}
        />
        <tbody>
          {allFindings.map((f) => {
            const key = ackKey(f.runId, f.kind, f.path);
            const isAcked = acknowledged.has(key);
            return (
              <tr
                key={key}
                style={{
                  borderBottom: "1px solid var(--rule)",
                  opacity: isAcked ? 0.4 : 1,
                }}
              >
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--advisory-ink)",
                  }}
                >
                  {f.kind}
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--wiki)",
                  }}
                >
                  {f.path}
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    color: "var(--ink-2)",
                    maxWidth: 380,
                  }}
                >
                  {f.detail}
                </td>
                <td style={{ padding: "10px 8px" }}>
                  {!isAcked && (
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <Btn
                        variant="ghost"
                        onClick={(): void => {
                          void handleAck(f.runId, f.kind, f.path);
                        }}
                      >
                        {t("review.lintFindings.acknowledge")}
                      </Btn>
                      {ackErrors[key] !== undefined && (
                        <span style={{ fontSize: 11, color: "var(--alert)" }}>
                          {ackErrors[key]}
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
