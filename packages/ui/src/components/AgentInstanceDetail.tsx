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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { AgentInstancePromptsSection } from "./AgentInstancePromptsSection.js";
import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import { MultiSelectDomains } from "./MultiSelectDomains.js";
import { SavingDot, type SavingDotState } from "./SavingDot.js";
import { useToast } from "./Toast.js";
import { TooltipTrigger } from "./Tooltip.js";
import { useOptimisticPatch } from "../hooks/useOptimisticPatch.js";
import {
  ApiAuthError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import { safeErrorMessage } from "../lib/safe-error.js";
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
  const toastApi = useToast();
  const opts = fetchOptsFor(props.fetchImpl);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // ── Optimistic-patch lifecycle cues (PR-B5, wave-16; PR-B5+, wave-17) ──
  // The saving-cue dot next to each whitelisted field renders one of
  // four states (`idle | saving | success | error`) projected from
  // `useOptimisticPatch`'s `saving + lastError` pair via local state.
  // The B7 alert toast surfaces on rollback via `fireRollbackToast`.
  //
  // Wave-16 baseline routed `enabled` through the hook. Wave-17 B5+
  // extends the wiring to `name`, `locale`, and `scope_domain_ids`
  // (the per-field Save buttons stay; their PATCH dispatch now flows
  // through useOptimisticPatch so the row beneath sees the new value
  // immediately, the saving-cue dot fades in, and on 422 the field
  // reverts + the B7 alert toast surfaces).
  const [enabledCueState, setEnabledCueState] =
    useState<SavingDotState>("idle");
  const [nameCueState, setNameCueState] = useState<SavingDotState>("idle");
  const [localeCueState, setLocaleCueState] =
    useState<SavingDotState>("idle");
  const [scopeCueState, setScopeCueState] = useState<SavingDotState>("idle");

  const fireRollbackToast = useCallback(
    (err: unknown): void => {
      toastApi.alert({
        message: t("optimistic.savingError"),
        details: safeErrorMessage(err),
      });
    },
    [toastApi, t],
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

  // ── Enabled state (optimistic, PR-B5) ──────────────────────────────────
  // Operator clicks Disable/Enable → UI flips immediately and the
  // saving-cue dot fades in. On success the dot brief-flashes green;
  // on failure the dot turns red, the value rolls back, and the B7
  // alert toast surfaces via `fireRollbackToast`. The PATCH wire body
  // is unchanged from the prior implementation.

  const applyEnabled = useCallback(
    async (next: boolean): Promise<boolean> => {
      setEnabledCueState("saving");
      try {
        await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
          method: "PATCH",
          body: { enabled: next },
          ...opts,
        });
        if (mountedRef.current) {
          setEnabledCueState("success");
          props.onChanged();
        }
        return next;
      } catch (err) {
        if (mountedRef.current) setEnabledCueState("error");
        throw err;
      }
    },
    [props, opts],
  );
  const enabledOptimistic = useOptimisticPatch<boolean>(
    props.instance.enabled,
    applyEnabled,
    { rollbackToast: fireRollbackToast },
  );
  const enabled = enabledOptimistic.value;

  const toggleEnabledOptimistic = (): void => {
    if (enabledOptimistic.saving) return;
    enabledOptimistic.setValue(!enabled);
  };

  // ── Schedule state ─────────────────────────────────────────────────────

  const [scheduleCron, setScheduleCron] = useState<string>(
    props.instance.scheduleCron ?? "",
  );
  const scheduleDirty = scheduleCron !== (props.instance.scheduleCron ?? "");

  // ── Name state (PR-W4-UI; optimistic via PR-B5+, wave-17) ──────────────
  //
  // The textarea draft is local; submitting routes through
  // `useOptimisticPatch` so the row beneath the modal sees the new
  // name immediately. `nameOptimistic.value` is the committed name
  // (rolls back to the prior value on 422 + surfaces alert toast).

  const [nameError, setNameError] = useState<string | null>(null);
  const applyName = useCallback(
    async (next: string): Promise<string> => {
      setNameCueState("saving");
      try {
        await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
          method: "PATCH",
          body: { name: next },
          ...opts,
        });
        if (mountedRef.current) {
          setNameCueState("success");
          props.onChanged();
        }
        return next;
      } catch (err) {
        if (mountedRef.current) setNameCueState("error");
        throw err;
      }
    },
    [props, opts],
  );
  const nameOptimistic = useOptimisticPatch<string>(
    props.instance.name,
    applyName,
    { rollbackToast: fireRollbackToast },
  );
  const [nameDraft, setNameDraft] = useState<string>(props.instance.name);
  const nameDirty =
    nameDraft.trim() !== nameOptimistic.value &&
    nameDraft.trim().length > 0;

  // ── Locale state (PR-W4-UI; optimistic via PR-B5+, wave-17) ────────────

  /** Server enum is `en | pl | auto`. The widget pins these literally;
   *  the API's Zod parser is the source of truth and will 422 on a
   *  future addition that lands here first. */
  const LOCALES = ["en", "pl", "auto"] as const;
  type LocaleOpt = (typeof LOCALES)[number];
  const initialLocale = ((): LocaleOpt => {
    const v = props.instance.locale;
    if (v === "en" || v === "pl" || v === "auto") return v;
    return "en";
  })();
  const applyLocale = useCallback(
    async (next: LocaleOpt): Promise<LocaleOpt> => {
      setLocaleCueState("saving");
      try {
        await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
          method: "PATCH",
          body: { locale: next },
          ...opts,
        });
        if (mountedRef.current) {
          setLocaleCueState("success");
          props.onChanged();
        }
        return next;
      } catch (err) {
        if (mountedRef.current) setLocaleCueState("error");
        throw err;
      }
    },
    [props, opts],
  );
  const localeOptimistic = useOptimisticPatch<LocaleOpt>(
    initialLocale,
    applyLocale,
    { rollbackToast: fireRollbackToast },
  );
  const locale = localeOptimistic.value;

  // ── Scope state (PR-W4-UI; optimistic via PR-B5+, wave-17) ─────────────

  const initialScope = props.instance.scopeDomainIds ?? [];
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopeEditing, setScopeEditing] = useState<boolean>(false);
  // Editable draft, separate from the committed value below.
  const [scopeIds, setScopeIds] = useState<ReadonlyArray<string>>(initialScope);
  const applyScope = useCallback(
    async (
      next: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<string>> => {
      setScopeCueState("saving");
      try {
        await fetchAdmin(`/api/admin/agent-instances/${props.instance.id}`, {
          method: "PATCH",
          body: { scope_domain_ids: next },
          ...opts,
        });
        if (mountedRef.current) {
          setScopeCueState("success");
          props.onChanged();
        }
        return next;
      } catch (err) {
        if (mountedRef.current) setScopeCueState("error");
        throw err;
      }
    },
    [props, opts],
  );
  const scopeOptimistic = useOptimisticPatch<ReadonlyArray<string>>(
    initialScope,
    applyScope,
    { rollbackToast: fireRollbackToast },
  );
  // Committed (row-beneath-the-modal) value.
  const scopeCommitted = scopeOptimistic.value;
  const scopeDirty =
    scopeEditing &&
    (scopeIds.length !== scopeCommitted.length ||
      scopeIds.some((id, i) => scopeCommitted[i] !== id));

  // ── Memory-clear state (PR-W4-UI) ──────────────────────────────────────

  const [memoryConfirmAck, setMemoryConfirmAck] = useState<boolean>(false);
  const [memoryClearStage, setMemoryClearStage] = useState<"idle" | "confirm">(
    "idle",
  );

  // ── Domains-name lookup (PR-W4-UI) ────────────────────────────────────
  // The Scope chip list shows domain SLUGS, not raw UUIDs. We fetch
  // once on mount for the read-only chip render; the editor reuses
  // the MultiSelectDomains component which fetches its own catalog.

  type DomainShort = { id: string; slug: string; name: string };
  const [domainsCatalog, setDomainsCatalog] = useState<readonly DomainShort[]>(
    [],
  );
  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<{ rows: readonly DomainShort[] }>(
          "/api/admin/domains",
          opts,
        );
        if (!mountedRef.current) return;
        setDomainsCatalog(r.rows);
      } catch {
        // Silent — the chip list falls back to raw UUIDs and the
        // editor surfaces its own error.
      }
    })();
  }, []);
  const slugOf = (id: string): string => {
    const found = domainsCatalog.find((d) => d.id === id);
    return found?.slug ?? id;
  };

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

  // Note: the `enabled` PATCH now flows through `useOptimisticPatch`
  // — see `applyEnabled` + `toggleEnabledOptimistic` above (PR-B5).
  // The toggle button's onClick calls `toggleEnabledOptimistic`.

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

  // ── Name / Locale / Scope / Memory-clear (PR-W4-UI) ──────────────────

  const saveName = (): void => {
    if (onCooldown() || !nameDirty || nameOptimistic.saving) return;
    setNameError(null);
    nameOptimistic.setValue(nameDraft.trim());
    startCooldown();
  };

  const saveLocale = (next: LocaleOpt): void => {
    if (onCooldown() || next === locale || localeOptimistic.saving) return;
    localeOptimistic.setValue(next);
    startCooldown();
  };

  const saveScope = (): void => {
    if (onCooldown() || !scopeDirty || scopeOptimistic.saving) return;
    if (scopeIds.length === 0) {
      setScopeError(t("agentInstance.detail.errors.scopeRequired"));
      return;
    }
    setScopeError(null);
    // Close the chip-editor immediately so the row beneath shows the
    // new chips via `scopeOptimistic.value`. On 422 the value rolls
    // back; specific error codes (`unknown_scope_domain_ids` /
    // `duplicate_scope_domain_ids`) still surface in the inline slot
    // via the `lastError` effect below.
    setScopeEditing(false);
    scopeOptimistic.setValue(scopeIds);
    startCooldown();
  };

  /** Translate scope-specific 422 codes from `lastError` into the
   *  inline error slot. Each `useOptimisticPatch` cycle clears
   *  `lastError` on the next `setValue`, so this effect is idempotent
   *  across multiple submissions. Also re-opens the chip editor on
   *  error so the operator can see the inline error + the
   *  pre-failure draft they tried to commit (Copilot triage:
   *  closed-editor-on-422 hides the error slot otherwise). */
  useEffect((): void => {
    const err = scopeOptimistic.lastError;
    if (err === null) return;
    if (err instanceof ApiValidationError && err.status === 422) {
      const code = (err.body as { error?: string } | undefined)?.error;
      if (code === "unknown_scope_domain_ids") {
        setScopeError(
          t("agentInstance.detail.errors.unknownScopeDomainIds"),
        );
        setScopeEditing(true);
        return;
      }
      if (code === "duplicate_scope_domain_ids") {
        setScopeError(
          t("agentInstance.detail.errors.duplicateScopeDomainIds"),
        );
        setScopeEditing(true);
        return;
      }
    }
  }, [scopeOptimistic.lastError, t]);

  /** Map `name` PATCH 409 (`name_collision`) into the inline name
   *  error slot. Same idempotency story as scope above. */
  useEffect((): void => {
    const err = nameOptimistic.lastError;
    if (err === null) return;
    if (err instanceof ApiValidationError && err.status === 409) {
      const code = (err.body as { error?: string } | undefined)?.error;
      if (code === "name_collision") {
        setNameError(t("agentInstance.detail.errors.nameCollision"));
      }
    }
  }, [nameOptimistic.lastError, t]);

  const cancelScopeEdit = (): void => {
    setScopeIds(scopeCommitted);
    setScopeEditing(false);
    setScopeError(null);
  };

  const clearMemory = async (): Promise<void> => {
    if (busy || onCooldown()) return;
    setBusy(true);
    try {
      const r = await fetchAdmin<{ updated: boolean; priorBytes: number }>(
        `/api/admin/agent-instances/${props.instance.id}`,
        {
          method: "PATCH",
          body: { memory_clear: true },
          ...opts,
        },
      );
      if (!mountedRef.current) return;
      flashToast(
        "healthy",
        t("agentInstance.detail.memoryCleared", {
          bytes: r.priorBytes,
        }),
      );
      setMemoryClearStage("idle");
      setMemoryConfirmAck(false);
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

        {/* Name editor (PR-W4-UI; optimistic via PR-B5+) */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.name")}
          <SavingDot state={nameCueState} />
        </h3>
        <div style={SECTION_STYLE}>
          <input
            type="text"
            value={nameDraft}
            onChange={(e): void => {
              setNameDraft(e.target.value);
              setNameError(null);
            }}
            style={INPUT_STYLE}
            maxLength={100}
            disabled={busy || nameOptimistic.saving}
            aria-invalid={nameError !== null ? true : undefined}
          />
          {nameError !== null ? (
            <p
              role="alert"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                color: "var(--alert)",
                margin: 0,
              }}
            >
              {nameError}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn
              variant="ghost"
              onClick={(): void => {
                saveName();
              }}
              disabled={
                busy || onCooldown() || !nameDirty || nameOptimistic.saving
              }
            >
              {t("agentInstance.detail.saveName")}
            </Btn>
          </div>
        </div>

        {/* Scope editor (PR-W4-UI; optimistic via PR-B5+) */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.scope")}
          <TooltipTrigger term="scopeDomainIds" />
          <SavingDot state={scopeCueState} />
        </h3>
        <div style={SECTION_STYLE}>
          {scopeEditing ? (
            <>
              <MultiSelectDomains
                selectedIds={scopeIds}
                onChange={(next): void => {
                  setScopeIds(next);
                  setScopeError(null);
                }}
                disabled={busy}
                {...(props.fetchImpl !== undefined
                  ? { fetchImpl: props.fetchImpl }
                  : {})}
              />
              {scopeError !== null ? (
                <p
                  role="alert"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-micro)",
                    color: "var(--alert)",
                    margin: 0,
                  }}
                >
                  {scopeError}
                </p>
              ) : null}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                }}
              >
                <Btn
                  variant="ghost"
                  onClick={cancelScopeEdit}
                  disabled={busy}
                >
                  {t("agentInstance.detail.cancelScopeEdit")}
                </Btn>
                <Btn
                  variant="ghost"
                  onClick={(): void => {
                    saveScope();
                  }}
                  disabled={
                    busy ||
                    onCooldown() ||
                    !scopeDirty ||
                    scopeOptimistic.saving
                  }
                >
                  {t("agentInstance.detail.saveScope")}
                </Btn>
              </div>
            </>
          ) : (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div
                data-testid="scope-chips"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-micro)",
                }}
              >
                {scopeCommitted.length === 0 ? (
                  <span style={{ color: "var(--ink-3)" }}>
                    {t("agentInstance.detail.scopeEmpty")}
                  </span>
                ) : (
                  scopeCommitted.map((id) => (
                    <span
                      key={id}
                      data-domain-id={id}
                      style={{
                        border: "1px solid var(--rule)",
                        borderRadius: "var(--radius-m)",
                        padding: "2px 6px",
                        color: "var(--ink-1)",
                        background: "var(--paper-2)",
                      }}
                    >
                      {slugOf(id)}
                    </span>
                  ))
                )}
              </div>
              <Btn
                variant="ghost"
                onClick={(): void => setScopeEditing(true)}
                disabled={busy}
              >
                {t("agentInstance.detail.editScope")}
              </Btn>
            </div>
          )}
        </div>

        {/* Locale editor (PR-W4-UI; optimistic via PR-B5+) */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.locale")}
          <SavingDot state={localeCueState} />
        </h3>
        <div style={SECTION_STYLE}>
          <select
            value={locale}
            disabled={busy || onCooldown() || localeOptimistic.saving}
            onChange={(e): void => {
              const v = e.target.value;
              if (v === "en" || v === "pl" || v === "auto") {
                saveLocale(v);
              }
            }}
            style={INPUT_STYLE}
            aria-label={t("agentInstance.detail.locale")}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>

        {/* Output channels */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.outputChannels")}
        </h3>
        <div style={SECTION_STYLE}>
          {catalogError !== null ? (
            <div
              role="alert"
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

        {/* Enabled toggle (optimistic, PR-B5) */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.enabled")}
          <SavingDot state={enabledCueState} />
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
            onClick={toggleEnabledOptimistic}
            disabled={busy || enabledOptimistic.saving}
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

        {/* Memory clear (PR-W4-UI) — destructive; gated by confirm
            checkbox per the design-system rule for irreversible
            actions (DomainDetail hard-delete pattern). */}
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.memory")}
        </h3>
        <div style={SECTION_STYLE}>
          {memoryClearStage === "confirm" ? (
            <>
              <p style={HINT_STYLE}>
                {t("agentInstance.detail.memoryClearConfirmBody")}
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--fs-small)",
                  color: "var(--ink-2)",
                }}
              >
                <input
                  type="checkbox"
                  checked={memoryConfirmAck}
                  disabled={busy}
                  onChange={(e): void =>
                    setMemoryConfirmAck(e.target.checked)
                  }
                />
                {t("agentInstance.detail.memoryClearAck")}
              </label>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                }}
              >
                <Btn
                  variant="ghost"
                  onClick={(): void => {
                    setMemoryClearStage("idle");
                    setMemoryConfirmAck(false);
                  }}
                  disabled={busy}
                >
                  {t("agentInstance.detail.cancelMemoryClear")}
                </Btn>
                <Btn
                  variant="ghost"
                  onClick={(): void => {
                    void clearMemory();
                  }}
                  disabled={busy || onCooldown() || !memoryConfirmAck}
                >
                  {t("agentInstance.detail.confirmMemoryClear")}
                </Btn>
              </div>
            </>
          ) : (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <p style={HINT_STYLE}>
                {t("agentInstance.detail.memoryClearHint")}
              </p>
              <Btn
                variant="ghost"
                onClick={(): void => setMemoryClearStage("confirm")}
                disabled={busy || onCooldown()}
              >
                {t("agentInstance.detail.clearMemory")}
              </Btn>
            </div>
          )}
        </div>

        {/* Per-instance prompt overrides (PR-W7b) */}
        <AgentInstancePromptsSection
          instance={props.instance}
          onChanged={props.onChanged}
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl }
            : {})}
        />

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
