/**
 * AgentInstanceDetail — Agents row drill-down modal (PR-W2,
 * phase-a appendix #13 — closes G2).
 *
 * Mirrors `OutputChannelDetail` shape for layout + button
 * patterns and `SourceBindingDetail` for action sequencing.
 * Each Save dispatches ONE PATCH (the discriminated-union route
 * rejects mixed bodies) so the operator's intent maps 1:1 to
 * an audit verb (`agent_instance.bind_outputs` /
 * `set_enabled` / `set_schedule`).
 *
 * v0.1 surface:
 *   - Read-only identity panel (definition_slug, name,
 *     schedule_cron, enabled, last run summary, output_channel
 *     count).
 *   - Output-channel multi-select (checkboxes). Save dispatches
 *     `{output_channel_ids: [...]}`.
 *   - Enable/Disable button — dispatches `{enabled: !current}`.
 *   - Schedule editor — text input + Save dispatches
 *     `{schedule_cron: value}` with cron-syntax validation hint.
 *
 * 3s cooldown after each save (operator can't double-click).
 * Healthy-toned success toast + scrubbed error toast.
 *
 * Hard-nos honored: no gradients, no emoji, lowercase
 * `opencoo`, `--alert` reserved for destructive surfaces only,
 * design-system tokens only.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import {
  ApiAuthError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import type { AgentInstance, OutputChannel } from "../types.js";

/** Cooldown after a successful save — prevents accidental
 *  double-fires from the operator's reflex re-click. Mirrors
 *  the SCAN_NOW_DISABLE_MS pattern in SourceBindingDetail. */
const SAVE_COOLDOWN_MS = 3000;

export interface AgentInstanceDetailProps {
  readonly instance: AgentInstance;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

type ToastKind = "healthy" | "alert";

interface ToastState {
  readonly kind: ToastKind;
  readonly message: string;
}

const ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "180px 1fr",
  gap: 8,
  alignItems: "baseline",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
};

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const SECTION_HEADING_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  margin: 0,
  paddingTop: 8,
};

const INPUT_STYLE: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
  width: "100%",
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
};

const HINT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-3)",
  margin: 0,
};

const TOAST_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-m)",
  border: "1px solid var(--rule)",
};

function mapErr(err: unknown, fallbackKey: string): string {
  if (err instanceof ApiAuthError || err instanceof ApiValidationError) {
    if (err instanceof ApiValidationError) {
      // The route returns structured bodies for our error
      // codes — surface them as i18n keys when present, else
      // the raw error message (already scrubbed by the route).
      const body = err.body as { error?: string } | undefined;
      const code = body?.error;
      if (code !== undefined) return code;
    }
    return err.message;
  }
  return fallbackKey;
}

export function AgentInstanceDetail(
  props: AgentInstanceDetailProps,
): JSX.Element {
  const { t } = useTranslation();
  const opts = fetchOptsFor(props.fetchImpl);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // ── Output channels: fetch the catalog ─────────────────────────────────

  const [channelCatalog, setChannelCatalog] = useState<
    readonly OutputChannel[] | null
  >(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<{ rows: readonly OutputChannel[] }>(
          "/api/admin/output-channels",
          opts,
        );
        if (!mountedRef.current) return;
        setChannelCatalog(r.rows);
      } catch (err) {
        if (!mountedRef.current) return;
        // Pass the TRANSLATED string, not the i18n key — `mapErr`
        // returns its fallback verbatim, and the render path
        // displays it as-is. Copilot triage #2.
        setCatalogError(mapErr(err, t("errors.transient")));
      }
    })();
  }, []);

  // ── Channel-selection state ────────────────────────────────────────────

  const initialSelected = (): ReadonlyArray<string> => {
    const out: string[] = [];
    for (const binding of props.instance.outputChannelIds) {
      const cid = binding.config["channel_id"];
      if (typeof cid === "string" && cid.length > 0) out.push(cid);
    }
    return out;
  };
  const [selectedIds, setSelectedIds] = useState<ReadonlyArray<string>>(
    initialSelected(),
  );
  const [bindingsDirty, setBindingsDirty] = useState<boolean>(false);

  const toggleChannel = (channelId: string): void => {
    setBindingsDirty(true);
    setSelectedIds((prev) =>
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId],
    );
  };

  // ── Enabled state ──────────────────────────────────────────────────────

  const [enabled, setEnabled] = useState<boolean>(props.instance.enabled);

  // ── Schedule state ─────────────────────────────────────────────────────

  const [scheduleCron, setScheduleCron] = useState<string>(
    props.instance.scheduleCron ?? "",
  );
  const scheduleDirty = scheduleCron !== (props.instance.scheduleCron ?? "");

  // ── Save lifecycle ─────────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [toast, setToast] = useState<ToastState | null>(null);

  const onCooldown = (): boolean => Date.now() < cooldownUntil;

  const flashToast = (kind: ToastKind, message: string): void => {
    setToast({ kind, message });
    window.setTimeout(() => {
      if (mountedRef.current) setToast(null);
    }, SAVE_COOLDOWN_MS);
  };

  const startCooldown = (): void => {
    setCooldownUntil(Date.now() + SAVE_COOLDOWN_MS);
  };

  const saveBindings = async (): Promise<void> => {
    if (busy || onCooldown()) return;
    setBusy(true);
    try {
      await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
        method: "PATCH",
        body: { output_channel_ids: selectedIds },
        ...opts,
      });
      if (!mountedRef.current) return;
      flashToast("healthy", t("agentInstance.detail.bindOutputs.success"));
      setBindingsDirty(false);
      startCooldown();
      props.onChanged();
    } catch (err) {
      if (!mountedRef.current) return;
      flashToast("alert", mapErr(err, t("errors.bindOutputsFailed")));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveEnabled = async (): Promise<void> => {
    if (busy || onCooldown()) return;
    const next = !enabled;
    setBusy(true);
    try {
      await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
        method: "PATCH",
        body: { enabled: next },
        ...opts,
      });
      if (!mountedRef.current) return;
      setEnabled(next);
      flashToast(
        "healthy",
        next
          ? t("agentInstance.detail.enabledToggled.on")
          : t("agentInstance.detail.enabledToggled.off"),
      );
      startCooldown();
      props.onChanged();
    } catch (err) {
      if (!mountedRef.current) return;
      flashToast("alert", mapErr(err, t("errors.bindOutputsFailed")));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveSchedule = async (): Promise<void> => {
    if (busy || onCooldown() || !scheduleDirty) return;
    setBusy(true);
    try {
      await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
        method: "PATCH",
        body: { schedule_cron: scheduleCron },
        ...opts,
      });
      if (!mountedRef.current) return;
      flashToast("healthy", t("agentInstance.detail.scheduleSaved"));
      startCooldown();
      props.onChanged();
    } catch (err) {
      if (!mountedRef.current) return;
      flashToast("alert", mapErr(err, t("errors.bindOutputsFailed")));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Modal
      onClose={props.onClose}
      title={t("agentInstance.detail.title")}
      maxWidth={640}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Identity panel */}
        <div style={ROW_STYLE}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("agentInstance.detail.labels.definitionSlug")}
          </div>
          <div>{props.instance.definitionSlug}</div>
        </div>
        <div style={ROW_STYLE}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("agentInstance.detail.labels.name")}
          </div>
          <div>{props.instance.name}</div>
        </div>
        <div style={ROW_STYLE}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("agentInstance.detail.labels.lastRun")}
          </div>
          <div>
            {props.instance.lastRunStartedAt !== null
              ? `${props.instance.lastRunStartedAt} · ${props.instance.lastRunStatus ?? "—"}`
              : "—"}
          </div>
        </div>
        <div style={ROW_STYLE}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("agentInstance.detail.labels.boundChannels")}
          </div>
          <div>{props.instance.outputChannelCount}</div>
        </div>

        {/* Output channels */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.outputChannels")}
        </h3>
        <div style={SECTION_STYLE}>
          {catalogError !== null ? (
            <div
              style={{
                color: "var(--alert)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
              }}
            >
              {catalogError}
            </div>
          ) : channelCatalog === null ? (
            <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
          ) : channelCatalog.length === 0 ? (
            <div style={{ color: "var(--ink-3)" }}>
              {t("agentInstance.detail.outputChannelsEmpty")}
            </div>
          ) : (
            channelCatalog.map((c) => {
              const checked = selectedIds.includes(c.id);
              return (
                <label key={c.id} style={CHECKBOX_ROW_STYLE}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(): void => toggleChannel(c.id)}
                    disabled={busy}
                  />
                  <span style={{ color: "var(--ink-3)" }}>{c.adapterSlug}</span>
                  <span>—</span>
                  <span>{c.name}</span>
                  {!c.enabled ? (
                    <span style={{ color: "var(--ink-3)" }}>
                      ({t("outputs.enabledNo")})
                    </span>
                  ) : null}
                </label>
              );
            })
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn
              variant="ghost"
              onClick={(): void => {
                void saveBindings();
              }}
              disabled={busy || onCooldown() || !bindingsDirty}
            >
              {t("agentInstance.detail.saveOutputChannels")}
            </Btn>
          </div>
        </div>

        {/* Enabled toggle */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.enabled")}
        </h3>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
          }}
        >
          <div style={{ color: enabled ? "var(--healthy)" : "var(--ink-3)" }}>
            {enabled ? t("outputs.enabledYes") : t("outputs.enabledNo")}
          </div>
          <Btn
            variant="ghost"
            onClick={(): void => {
              void saveEnabled();
            }}
            disabled={busy || onCooldown()}
          >
            {enabled
              ? t("agentInstance.detail.disable")
              : t("agentInstance.detail.enable")}
          </Btn>
        </div>

        {/* Schedule editor */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.scheduleCron")}
        </h3>
        <div style={SECTION_STYLE}>
          <input
            type="text"
            value={scheduleCron}
            onChange={(e): void => setScheduleCron(e.target.value)}
            style={INPUT_STYLE}
            placeholder="0 6 * * 1-5"
            disabled={busy}
          />
          <p style={HINT_STYLE}>
            {t("agentInstance.detail.scheduleCronHint")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn
              variant="ghost"
              onClick={(): void => {
                void saveSchedule();
              }}
              disabled={busy || onCooldown() || !scheduleDirty}
            >
              {t("agentInstance.detail.saveSchedule")}
            </Btn>
          </div>
        </div>

        {/* Toast region */}
        {toast !== null ? (
          <div
            style={{
              ...TOAST_BASE_STYLE,
              color:
                toast.kind === "healthy" ? "var(--healthy)" : "var(--alert)",
              borderColor:
                toast.kind === "healthy" ? "var(--healthy)" : "var(--alert)",
              background: "var(--paper-2)",
            }}
          >
            {toast.message}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={props.onClose}>
            {t("agentInstance.detail.close")}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
