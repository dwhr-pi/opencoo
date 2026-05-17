/**
 * Review Dashboard — source-binding review sub-view.
 *
 * Consumes `GET /api/admin/source-bindings` with the PR-C addition
 * of `pendingEventsCount`. Lets the operator flip a binding from
 * `review_mode='review'` to `auto` via the existing
 * `POST /api/admin/source-bindings/:id/review-mode` endpoint (PR #28).
 *
 * Security invariants (THREAT-MODEL §3.13):
 *   - All state-changing actions fire existing audited endpoints.
 *   - No new state-machine code introduced here.
 *   - Sovereignty-diff confirmation before any action that changes
 *     the binding's effective LLM policy scope.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../../components/Btn.js";
import { EmptyStatePanel } from "../../components/EmptyStatePanel.js";
import { NoticeRow } from "../../components/NoticeRow.js";
import { StatusPill } from "../../components/StatusPill.js";
import { fetchAdmin, fetchOptsFor } from "../../lib/api.js";
import type { SourceBinding } from "../../types.js";
import { ReviewTableHeader } from "./ReviewTableHeader.js";

// ─── Extended binding type with PR-C addition ────────────────────────────────

export interface ReviewSourceBinding extends SourceBinding {
  /** Count of webhook_events rows with status='pending'. PR-C addition. */
  readonly pendingEventsCount: number;
}

interface SourceBindingsResponse {
  readonly rows: readonly ReviewSourceBinding[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SourceBindingsReviewProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Sovereignty-diff confirmation dialog ─────────────────────────────────────

interface SovereigntyConfirmProps {
  readonly bindingName: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function SovereigntyConfirm(props: SovereigntyConfirmProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      aria-label="sovereignty-diff-confirm"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: "var(--paper)",
          border: "1px solid var(--rule)",
          borderRadius: 6,
          padding: "28px 32px",
          maxWidth: 460,
          width: "100%",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--advisory-ink)",
            marginBottom: 12,
          }}
        >
          {t("review.sovereigntyConfirm.title")}
        </div>
        <p style={{ fontSize: 13, color: "var(--ink)", marginBottom: 20 }}>
          {t("review.sovereigntyConfirm.body", { name: props.bindingName })}
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={props.onCancel}>
            {t("common.cancel")}
          </Btn>
          <Btn variant="primary" onClick={props.onConfirm}>
            {t("review.sovereigntyConfirm.confirm")}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SourceBindingsReview(
  props: SourceBindingsReviewProps = {},
): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly ReviewSourceBinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    binding: ReviewSourceBinding;
    action: "approve";
  } | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<SourceBindingsResponse>(
          "/api/admin/source-bindings",
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
    // PR-B3 (wave-16) — promote the route-level "review queue is
    // empty" surface to the EmptyStatePanel shape. The sub-tab
    // sentinel under `review.sourceBindings.empty` is retained for
    // tests but the operator-facing copy is now the route-level
    // `review.emptyState.*` block.
    return (
      <EmptyStatePanel
        title={t("review.emptyState.title")}
        body={t("review.emptyState.body")}
      />
    );
  }

  const handleApproveClick = (binding: ReviewSourceBinding): void => {
    // THREAT-MODEL §3.13: if the binding is in 'review' mode, show
    // the sovereignty-diff confirmation before committing — the action
    // may change the binding's effective LLM policy scope.
    if (binding.reviewMode === "review") {
      setPendingConfirm({ binding, action: "approve" });
    } else {
      void executeApprove(binding);
    }
  };

  const executeApprove = async (binding: ReviewSourceBinding): Promise<void> => {
    try {
      await fetchAdmin(
        `/api/admin/source-bindings/${binding.id}/review-mode`,
        {
          method: "POST",
          body: { reviewMode: "auto" },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      // Refresh the list after successful action.
      const r = await fetchAdmin<SourceBindingsResponse>(
        "/api/admin/source-bindings",
        fetchOptsFor(props.fetchImpl),
      );
      setRows(r.rows);
    } catch {
      setActionErrors((prev) => ({ ...prev, [binding.id]: t("common.error") }));
    }
  };

  return (
    <>
      {pendingConfirm !== null && (
        <SovereigntyConfirm
          bindingName={pendingConfirm.binding.name}
          onConfirm={(): void => {
            const binding = pendingConfirm.binding;
            setPendingConfirm(null);
            void executeApprove(binding);
          }}
          onCancel={(): void => {
            setPendingConfirm(null);
          }}
        />
      )}
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
            t("review.sourceBindings.columns.name"),
            t("review.sourceBindings.columns.status"),
            t("review.sourceBindings.columns.pending"),
            t("review.sourceBindings.columns.mode"),
            t("review.sourceBindings.columns.actions"),
          ]}
        />
        <tbody>
          {rows.map((binding) => (
            <tr key={binding.id} style={{ borderBottom: "1px solid var(--rule)" }}>
              <td
                style={{
                  padding: "10px 8px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
              >
                {binding.name}
              </td>
              <td style={{ padding: "10px 8px" }}>
                {binding.status !== null ? (
                  <StatusPill tone={binding.status}>
                    {binding.status}
                  </StatusPill>
                ) : (
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}
                  >
                    —
                  </span>
                )}
              </td>
              <td
                style={{
                  padding: "10px 8px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: binding.pendingEventsCount > 0 ? "var(--advisory-ink)" : "var(--ink-3)",
                }}
              >
                {binding.pendingEventsCount > 0 ? (
                  <strong>{binding.pendingEventsCount}</strong>
                ) : (
                  "0"
                )}
              </td>
              <td
                style={{
                  padding: "10px 8px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--ink-2)",
                }}
              >
                {binding.reviewMode}
              </td>
              <td style={{ padding: "10px 8px" }}>
                {binding.reviewMode === "review" || binding.reviewMode === "approve" ? (
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Btn
                      variant="primary"
                      onClick={(): void => handleApproveClick(binding)}
                    >
                      {t("review.sourceBindings.approve")}
                    </Btn>
                    {actionErrors[binding.id] !== undefined && (
                      <span
                        style={{ fontSize: 11, color: "var(--alert)" }}
                      >
                        {actionErrors[binding.id]}
                      </span>
                    )}
                  </span>
                ) : (
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}
                  >
                    —
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
