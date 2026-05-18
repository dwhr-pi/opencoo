/**
 * LLM policy tab — preview + apply with sovereignty-diff
 * confirmation. Uses PR 28's `verifySovereigntyDiffToken`
 * primitives via the new `/preview` and `/apply` endpoints
 * (decision Q4 — paired with this UI).
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 * `--alert` only on error display + apply-error mono line;
 * `--healthy` only on the apply-success indicator.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { DiffPreviewDialog } from "../components/DiffPreviewDialog.js";
import {
  LlmPolicyEditor,
  type LlmPolicyValue,
} from "../components/LlmPolicyEditor.js";
import { ApiValidationError, fetchAdmin } from "../lib/api.js";
import {
  markRouteFetchEnd,
  markRouteFetchStart,
  measureRouteNav,
} from "../lib/perf-marks.js";
import type { Domain, SovereigntyDiffPreview } from "../types.js";

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain & { llmPolicy?: Record<string, unknown> }>;
}

export function LlmPolicy(): JSX.Element {
  const { t } = useTranslation();
  const [domains, setDomains] = useState<DomainsResponse["rows"] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // PR-Q13 (phase-a appendix #9) — `proposed` is the structured
  // value the editor emits, NOT a raw-JSON string. The shape is
  // identical to what the prior textarea serialised, so the
  // preview/apply server contract is unchanged.
  const [proposed, setProposed] = useState<LlmPolicyValue>({});
  // Copilot triage round-2 (Comment 1): the editor only emits
  // onChange when all three tiers carry a non-empty model. Until
  // it does, Preview/Apply are disabled and an inline hint
  // explains why. Default to true so a fully-populated incoming
  // policy renders Preview enabled before the editor has had a
  // chance to fire onValidityChange.
  const [editorComplete, setEditorComplete] = useState<boolean>(true);
  const [preview, setPreview] = useState<SovereigntyDiffPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  // PR-B8+ (wave-17) — first-fetch-only nav measure (see Domains).
  // The post-apply re-fetch in `applyClick` shares the route's
  // click mark but is an intra-route refresh, not a nav.
  const didMeasureNavRef = useRef(false);

  useEffect((): void => {
    markRouteFetchStart("llmPolicy");
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<DomainsResponse>("/api/admin/domains");
        setDomains(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        markRouteFetchEnd("llmPolicy");
        if (!didMeasureNavRef.current) {
          didMeasureNavRef.current = true;
          measureRouteNav("llmPolicy");
        }
      }
    })();
  }, []);

  const selected = domains?.find((d) => d.id === selectedId) ?? null;

  const onSelect = (d: DomainsResponse["rows"][number]): void => {
    setSelectedId(d.id);
    setProposed((d.llmPolicy ?? {}) as LlmPolicyValue);
    setPreview(null);
    setAppliedNotice(null);
    setApplyError(null);
  };

  /** Map a server `ApiValidationError` to an operator-friendly i18n
   *  string by reading the structured `{reason}` body the server
   *  emits — NOT the message string (which is just `Admin API
   *  validation error (HTTP 422)` and contains no semantic info). */
  const mapApplyError = (err: unknown): string => {
    if (err instanceof ApiValidationError) {
      const body = err.body as { reason?: string } | undefined;
      if (body?.reason === "payload_mismatch") return t("llmPolicy.tokenMismatch");
      if (body?.reason === "expired") return t("llmPolicy.diffExpired");
    }
    return err instanceof Error ? err.message : String(err);
  };

  const previewClick = async (): Promise<void> => {
    if (selectedId === null) return;
    setApplyError(null);
    try {
      const r = await fetchAdmin<SovereigntyDiffPreview>(
        `/api/admin/domains/${selectedId}/llm-policy/preview`,
        { method: "POST", body: { proposed } },
      );
      setPreview(r);
    } catch (err) {
      setApplyError(mapApplyError(err));
    }
  };

  const applyClick = async (): Promise<void> => {
    if (selectedId === null || preview === null) return;
    try {
      await fetchAdmin(`/api/admin/domains/${selectedId}/llm-policy/apply`, {
        method: "POST",
        // `confirmDiff: true` is the explicit "I saw the diff"
        // acknowledgment the server requires (in addition to the
        // replay-protected token) before mutating llm_policy.
        body: { proposed, token: preview.token, confirmDiff: true },
      });
      setPreview(null);
      setAppliedNotice(t("llmPolicy.applied"));
      // Re-fetch the current policy.
      const r = await fetchAdmin<DomainsResponse>("/api/admin/domains");
      setDomains(r.rows);
    } catch (err) {
      setApplyError(mapApplyError(err));
    }
  };

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 id="opencoo-page-h1" style={{ margin: 0 }}>{t("llmPolicy.title")}</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("llmPolicy.subtitle")}</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 16 }}>
        <Card>
          {error !== null ? (
            <div role="alert" style={{ color: "var(--alert)" }}>{error}</div>
          ) : domains === null ? (
            <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {domains.map((d) => (
                <button
                  key={d.id}
                  onClick={(): void => onSelect(d)}
                  style={{
                    textAlign: "left",
                    font: "inherit",
                    padding: "6px 8px",
                    background: selectedId === d.id ? "var(--paper-2)" : "transparent",
                    border: "1px solid",
                    borderColor: selectedId === d.id ? "var(--rule)" : "transparent",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-mono)",
                  }}
                >
                  {d.slug}
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card>
          {selected === null ? (
            <div style={{ color: "var(--ink-3)" }}>{t("llmPolicy.empty")}</div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
              aria-label={`llm-policy-${selected.slug}`}
            >
              <LlmPolicyEditor
                value={proposed}
                onChange={(next): void => setProposed(next)}
                onValidityChange={(complete): void => setEditorComplete(complete)}
              />
              {!editorComplete ? (
                <div
                  data-testid="editor-incomplete"
                  style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}
                >
                  {t("llmPolicy.editor.incomplete")}
                </div>
              ) : null}
              {appliedNotice !== null ? (
                <div style={{ color: "var(--healthy)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
                  {appliedNotice}
                </div>
              ) : null}
              {applyError !== null ? (
                <div data-testid="apply-error" role="alert" style={{ color: "var(--alert)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
                  {applyError}
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn
                  variant="primary"
                  disabled={!editorComplete}
                  onClick={(): void => void previewClick()}
                >
                  {t("llmPolicy.preview")}
                </Btn>
              </div>
            </div>
          )}
        </Card>
      </div>
      {preview !== null ? (
        <DiffPreviewDialog
          preview={preview}
          onApply={applyClick}
          onCancel={(): void => setPreview(null)}
          errorMessage={applyError}
        />
      ) : null}
    </div>
  );
}
