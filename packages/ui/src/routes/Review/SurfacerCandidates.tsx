/**
 * Review Dashboard — Surfacer candidates sub-view.
 *
 * Consumes `GET /api/admin/automation-candidates` (existing endpoint).
 * Approve/reject fires `POST /api/admin/automation-candidates/:id/decision`
 * (existing PR #28 state-machine endpoint).
 *
 * State machine: proposed → approved | rejected.
 * A 409 response means an illegal transition (row already decided);
 * the component shows an inline conflict notice.
 *
 * Security: all state-changing calls use existing audited endpoints
 * with CSRF tokens injected by fetchAdmin. No new endpoints.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../../components/Btn.js";
import { NoticeRow } from "../../components/NoticeRow.js";
import { ApiValidationError, fetchAdmin, fetchOptsFor } from "../../lib/api.js";
import { formatDate } from "../../lib/intl-format.js";
import { ReviewTableHeader } from "./ReviewTableHeader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AutomationCandidate {
  readonly id: string;
  readonly surfacerRunId: string;
  readonly sourcePageRefs: unknown;
  readonly proposal: unknown;
  readonly status: string;
  readonly rationale: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
}

interface AutomationCandidatesResponse {
  readonly rows: readonly AutomationCandidate[];
}

type RowDecision = "approved" | "rejected" | "conflict" | "error";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SurfacerCandidatesProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractProposalTitle(proposal: unknown): string {
  if (
    typeof proposal === "object" &&
    proposal !== null &&
    "title" in proposal &&
    typeof (proposal as { title?: unknown }).title === "string"
  ) {
    return (proposal as { title: string }).title;
  }
  return "—";
}

// ─── Action cell ──────────────────────────────────────────────────────────────

interface DecisionCellProps {
  readonly decision: RowDecision | undefined;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly approveLabel: string;
  readonly rejectLabel: string;
  readonly conflictLabel: string;
  readonly errorLabel: string;
}

function DecisionCell(props: DecisionCellProps): JSX.Element {
  switch (props.decision) {
    case "approved":
    case "rejected":
      return (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color:
              props.decision === "approved" ? "var(--healthy)" : "var(--ink-3)",
          }}
        >
          {props.decision}
        </span>
      );
    case "conflict":
      return (
        <span style={{ fontSize: 12, color: "var(--advisory-ink)" }}>
          {props.conflictLabel}
        </span>
      );
    case "error":
      return (
        <span style={{ fontSize: 12, color: "var(--alert)" }}>
          {props.errorLabel}
        </span>
      );
    default:
      return (
        <span style={{ display: "flex", gap: 8 }}>
          <Btn variant="primary" onClick={props.onApprove}>
            {props.approveLabel}
          </Btn>
          <Btn variant="ghost" onClick={props.onReject}>
            {props.rejectLabel}
          </Btn>
        </span>
      );
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SurfacerCandidates(
  props: SurfacerCandidatesProps = {},
): JSX.Element {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<readonly AutomationCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row decision result: id → decision state
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<AutomationCandidatesResponse>(
          "/api/admin/automation-candidates",
          fetchOptsFor(props.fetchImpl),
        );
        setRows(r.rows);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (rows === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (rows.length === 0) {
    return <NoticeRow tone="muted">{t("review.candidates.empty")}</NoticeRow>;
  }

  const handleDecision = async (
    id: string,
    decision: "approve" | "reject",
    rationale?: string,
  ): Promise<void> => {
    try {
      await fetchAdmin(
        `/api/admin/automation-candidates/${id}/decision`,
        {
          method: "POST",
          body: { decision, ...(rationale !== undefined ? { rationale } : {}) },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      const resolved: RowDecision = decision === "approve" ? "approved" : "rejected";
      setDecisions((prev) => ({ ...prev, [id]: resolved }));
    } catch (err) {
      if (
        err instanceof ApiValidationError &&
        err.status === 409
      ) {
        // Illegal transition — the row was already decided by another session.
        setDecisions((prev) => ({ ...prev, [id]: "conflict" }));
      } else {
        setDecisions((prev) => ({ ...prev, [id]: "error" }));
      }
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
            t("review.candidates.columns.proposal"),
            t("review.candidates.columns.sourcePages"),
            t("review.candidates.columns.created"),
            t("review.candidates.columns.actions"),
          ]}
        />
        <tbody>
          {rows.map((candidate) => {
            const rowDecision = decisions[candidate.id];
            const isDecided =
              rowDecision === "approved" || rowDecision === "rejected";
            return (
              <tr
                key={candidate.id}
                style={{
                  borderBottom: "1px solid var(--rule)",
                  opacity: isDecided ? 0.5 : 1,
                }}
              >
                <td style={{ padding: "10px 8px", maxWidth: 280 }}>
                  <div
                    style={{ fontWeight: 500, color: "var(--ink)", marginBottom: 2 }}
                  >
                    {extractProposalTitle(candidate.proposal)}
                  </div>
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--wiki)",
                    maxWidth: 200,
                  }}
                >
                  {Array.isArray(candidate.sourcePageRefs)
                    ? candidate.sourcePageRefs.slice(0, 2).join(", ")
                    : "—"}
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                  }}
                >
                  {formatDate(candidate.createdAt, i18n.language)}
                </td>
                <td style={{ padding: "10px 8px" }}>
                  <DecisionCell
                    decision={rowDecision}
                    onApprove={(): void => {
                      void handleDecision(candidate.id, "approve");
                    }}
                    onReject={(): void => {
                      void handleDecision(candidate.id, "reject");
                    }}
                    approveLabel={t("review.candidates.approve")}
                    rejectLabel={t("review.candidates.reject")}
                    conflictLabel={t("review.candidates.conflict")}
                    errorLabel={t("common.error")}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
