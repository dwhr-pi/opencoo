/**
 * Outputs tab — list of `output_channels` rows (PR-Z4, phase-a
 * appendix #12 G5; multi-select bulk-delete in PR-W6, phase-a
 * appendix #15).
 *
 * Mirrors `Sources.tsx`'s shape: list + `+ New output channel`
 * modal + per-row drill-down. The list pulls from
 * `/api/admin/output-channels`; the modal pulls the adapter
 * descriptor map from `/api/admin/adapters` (the same endpoint
 * the source-bindings modal uses, extended with `outputAdapters[]`).
 *
 * Multi-select (PR-W6):
 *   - Left-most checkbox column on every row.
 *   - Header checkbox selects/deselects all currently-listed rows.
 *   - When one or more rows are selected, a `Delete N` button
 *     reveals; clicking opens a destructive-confirm modal with
 *     the checkbox-gated pattern from DomainDetail.
 *   - On confirm: POST `/api/admin/output-channels/bulk-delete`
 *     with the selected id array; the list refreshes on success.
 *
 * Hard-nos honored: no gradients, no emoji, lowercase opencoo,
 * `--alert` reserved for destructive surfaces, design-system
 * tokens only.
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 * `--alert` only on the bulk-delete confirm + destructive button;
 * `--healthy` only on the enabled-status indicator.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { EmptyStatePanel } from "../components/EmptyStatePanel.js";
import { Modal } from "../components/Modal.js";
import { NewOutputChannelModal } from "../components/NewOutputChannelModal.js";
import { OutputChannelDetail } from "../components/OutputChannelDetail.js";
import { useToast } from "../components/Toast.js";
import {
  fetchAdmin,
  fetchOptsFor,
  ApiAuthError,
  ApiTransientError,
} from "../lib/api.js";
import {
  markRouteFetchEnd,
  markRouteFetchStart,
  measureRouteNav,
} from "../lib/perf-marks.js";
import type { OutputChannel } from "../types.js";

interface OutputsResponse {
  readonly rows: readonly OutputChannel[];
}

interface BulkDeleteResponse {
  readonly deleted: number;
  readonly skipped: number;
}

export interface OutputsProps {
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

const CHECKBOX_CELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "4px 0",
};

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const CONFIRM_BODY_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--fg-2)",
};

const CONFIRM_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

const DESTRUCTIVE_CONFIRM_BTN_STYLE: CSSProperties = {
  background: "var(--alert)",
  color: "var(--paper)",
  border: "1px solid var(--alert)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

export function Outputs(props: OutputsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<readonly OutputChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<OutputChannel | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [bulkStage, setBulkStage] = useState<"idle" | "confirm">("idle");
  const [bulkAck, setBulkAck] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkActionError, setBulkActionError] = useState<string | null>(null);
  // Bulk-delete success notice migrated from a local inline toast
  // (timer + setState on unmount risk) to the global Toast queue
  // (PR-B7, wave-16). The queue owns the timer; unmounting the
  // route cancels it via Toast's own cleanup. Inline-modal error
  // strings (`bulkActionError`) stay local — they belong inside
  // the open confirm modal next to the disabled confirm button
  // so the operator sees them before the modal closes.
  const opts = fetchOptsFor(props.fetchImpl);

  // PR-B8+ (wave-17) — first-fetch-only nav measure (see Domains).
  const didMeasureNavRef = useRef(false);

  useEffect((): void => {
    markRouteFetchStart("outputs");
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<OutputsResponse>(
          "/api/admin/output-channels",
          opts,
        );
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        markRouteFetchEnd("outputs");
        if (!didMeasureNavRef.current) {
          didMeasureNavRef.current = true;
          measureRouteNav("outputs");
        }
      }
    })();
  }, [refreshNonce]);

  // Prune selectedIds to the currently-listed rows so a refresh that
  // dropped a row clears its checkbox from state.
  useEffect((): void => {
    if (rows === null) return;
    const visible = new Set(rows.map((r) => r.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const allSelected = useMemo((): boolean => {
    if (rows === null || rows.length === 0) return false;
    return rows.every((r) => selectedIds.has(r.id));
  }, [rows, selectedIds]);

  const toggleOne = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = (): void => {
    if (rows === null) return;
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  };

  const openBulkConfirm = (): void => {
    setBulkAck(false);
    setBulkActionError(null);
    setBulkStage("confirm");
  };

  const closeBulkConfirm = (): void => {
    if (bulkSubmitting) return;
    setBulkStage("idle");
    setBulkAck(false);
    setBulkActionError(null);
  };

  const submitBulkDelete = async (): Promise<void> => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkActionError(null);
    setBulkSubmitting(true);
    try {
      const r = await fetchAdmin<BulkDeleteResponse>(
        "/api/admin/output-channels/bulk-delete",
        {
          method: "POST",
          body: { ids },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      setBulkStage("idle");
      setBulkAck(false);
      setSelectedIds(new Set());
      toast.success(
        t("outputs.bulkDelete.successToast", {
          deleted: r.deleted,
          skipped: r.skipped,
        }),
      );
      setRefreshNonce((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        setBulkActionError(t("outputs.bulkDelete.errors.auth"));
      } else if (err instanceof ApiTransientError) {
        setBulkActionError(t("outputs.bulkDelete.errors.transient"));
      } else {
        setBulkActionError(t("outputs.bulkDelete.errors.generic"));
      }
    } finally {
      setBulkSubmitting(false);
    }
  };

  const selectedCount = selectedIds.size;

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h1 id="opencoo-page-h1" style={{ margin: 0 }}>{t("outputs.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("outputs.subtitle")}</p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {selectedCount > 0 ? (
            <button
              type="button"
              onClick={openBulkConfirm}
              style={DESTRUCTIVE_CONFIRM_BTN_STYLE}
              data-testid="outputs-bulk-delete-btn"
            >
              {t("outputs.bulkDelete.button", { count: selectedCount })}
            </button>
          ) : null}
          <Btn variant="primary" onClick={(): void => setCreateOpen(true)}>
            {t("outputs.newChannel")}
          </Btn>
        </div>
      </div>
      {error === null && rows !== null && rows.length === 0 ? (
        <EmptyStatePanel
          title={t("outputs.emptyState.title")}
          body={t("outputs.emptyState.body")}
          cta={{
            label: t("outputs.emptyState.ctaLabel"),
            onClick: (): void => setCreateOpen(true),
          }}
        />
      ) : (
      <Card>
        {error !== null ? (
          <div
            role="alert"
            style={{
              color: "var(--alert)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
            }}
          >
            {error}
          </div>
        ) : rows === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1.4fr 1fr 1fr 1.2fr",
              gap: 12,
            }}
          >
            <div style={CHECKBOX_CELL_STYLE}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label={t("outputs.bulkDelete.selectAllAriaLabel")}
                data-testid="outputs-select-all"
              />
            </div>
            <div className="t-micro">{t("outputs.columns.name")}</div>
            <div className="t-micro">{t("outputs.columns.adapter")}</div>
            <div className="t-micro">{t("outputs.columns.enabled")}</div>
            <div className="t-micro">{t("outputs.columns.createdAt")}</div>
            {rows.map((c) => {
              // Mirrors `Sources.tsx`'s grid-row click target: every
              // cell shares the same `onClick` + `onKeyDown` + `aria-label`
              // so the operator can drill in from any column AND so
              // keyboard / screen-reader users get parity with mouse
              // users. The grid uses `display: contents` so we can't
              // wrap cells in a single clickable element without
              // breaking the layout — per-cell handlers are the
              // simplest path that preserves the grid.
              const onRowClick = (): void => setSelected(c);
              const onRowKey = (e: React.KeyboardEvent): void => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(c);
                }
              };
              const cellStyle: React.CSSProperties = {
                cursor: "pointer",
                padding: "4px 0",
              };
              const cellProps = {
                role: "button",
                tabIndex: 0,
                onClick: onRowClick,
                onKeyDown: onRowKey,
                "aria-label": t("outputs.detail.openAriaLabel", { name: c.name }),
              } as const;
              const isChecked = selectedIds.has(c.id);
              return (
                <div
                  key={c.id}
                  style={{ display: "contents" }}
                  data-channel-id={c.id}
                >
                  <div style={CHECKBOX_CELL_STYLE}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(): void => toggleOne(c.id)}
                      aria-label={t("outputs.bulkDelete.selectRowAriaLabel", {
                        name: c.name,
                      })}
                      data-testid={`outputs-select-row-${c.id}`}
                    />
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-mono)",
                    }}
                    {...cellProps}
                  >
                    {c.name}
                  </div>
                  <div
                    style={{ ...cellStyle, color: "var(--ink-3)" }}
                    {...cellProps}
                  >
                    {c.adapterSlug}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: c.enabled ? "var(--healthy)" : "var(--ink-3)",
                    }}
                    {...cellProps}
                  >
                    {c.enabled ? t("outputs.enabledYes") : t("outputs.enabledNo")}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: "var(--ink-3)",
                      fontSize: "var(--fs-micro)",
                      fontFamily: "var(--font-mono)",
                    }}
                    {...cellProps}
                  >
                    {c.createdAt ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      )}
      {createOpen ? (
        <NewOutputChannelModal
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onCreated={(): void => {
            setCreateOpen(false);
            setRefreshNonce((n) => n + 1);
          }}
          onClose={(): void => setCreateOpen(false)}
        />
      ) : null}
      {selected !== null ? (
        <OutputChannelDetail
          channel={selected}
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onClose={(): void => setSelected(null)}
          onChanged={(): void => {
            setSelected(null);
            setRefreshNonce((n) => n + 1);
          }}
        />
      ) : null}
      {bulkStage === "confirm" ? (
        <Modal
          title={t("outputs.bulkDelete.confirmTitle", { count: selectedCount })}
          onClose={closeBulkConfirm}
          maxWidth={520}
          actions={
            <div style={CONFIRM_FOOTER_STYLE}>
              <Btn
                variant="ghost"
                onClick={closeBulkConfirm}
                disabled={bulkSubmitting}
              >
                {t("outputs.bulkDelete.cancel")}
              </Btn>
              <button
                type="button"
                disabled={!bulkAck || bulkSubmitting}
                onClick={(): void => {
                  void submitBulkDelete();
                }}
                style={{
                  ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                  opacity: bulkAck && !bulkSubmitting ? 1 : 0.55,
                  cursor:
                    bulkAck && !bulkSubmitting ? "pointer" : "not-allowed",
                }}
                data-testid="outputs-bulk-delete-confirm"
              >
                {bulkSubmitting
                  ? t("outputs.bulkDelete.submitting")
                  : t("outputs.bulkDelete.confirm", { count: selectedCount })}
              </button>
            </div>
          }
        >
          <div style={SECTION_STYLE}>
            <p style={CONFIRM_BODY_STYLE}>
              {t("outputs.bulkDelete.confirmBody", { count: selectedCount })}
            </p>
            <label style={CHECKBOX_ROW_STYLE}>
              <input
                type="checkbox"
                checked={bulkAck}
                disabled={bulkSubmitting}
                onChange={(e): void => setBulkAck(e.target.checked)}
              />
              {t("outputs.bulkDelete.confirmCheckboxLabel")}
            </label>
            {bulkActionError !== null ? (
              <p style={ERROR_TEXT_STYLE} role="alert">
                {bulkActionError}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
