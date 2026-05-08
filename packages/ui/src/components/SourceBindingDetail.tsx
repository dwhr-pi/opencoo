/**
 * SourceBindingDetail — Sources row drill-down modal (PR-Q10,
 * phase-a appendix #9).
 *
 * Replaces the previous psql-only paths for two operator tasks:
 *   1. "What's the webhook URL I give Asana?" — formatted in
 *      mono with a copy button + healthy-toned confirmation flash
 *      (mirrors `CredentialForm`'s encrypted-note treatment).
 *   2. "Disable / Delete this binding" — both gated by an inline
 *      confirmation step, both routed through the CSRF-protected
 *      admin-API endpoints (PATCH + DELETE).
 *
 * Modal shape mirrors `Modal.tsx` + `PatEntryModal.tsx` (the only
 * other admin modals on this surface). Hard-nos honored:
 *   - no gradients, no drop shadows for elevation, no backdrop
 *     blur, no pills (radii cap at 6/10), no emoji
 *   - lowercase `opencoo` in any future copy strings
 *   - copy success uses the filled-disc glyph in `--healthy`,
 *     same as the CredentialForm encrypted-note
 *
 * THREAT-MODEL §3.13 — both mutating endpoints are CSRF-gated
 * server-side; the SPA's `fetchAdmin` already mirrors the
 * `opencoo_csrf` cookie as `X-CSRF-Token` for any PATCH/DELETE.
 * The webhook URL itself is the binding's UUID — operators sharing
 * it externally is by design (it is the public webhook target).
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { GlyphFilledDisc } from "./Glyph.js";
import { Modal } from "./Modal.js";
import {
  ApiAuthError,
  ApiTransientError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import type { SourceBinding } from "../types.js";

export interface SourceBindingDetailProps {
  readonly binding: SourceBinding;
  /** Called when the operator dismisses the modal (Esc, backdrop,
   *  or "Close" button) AND when a successful Disable/Delete
   *  action completes — the row list refetches via `onChanged`,
   *  and the modal closes so the operator returns to the list. */
  readonly onClose: () => void;
  /** Called when the binding's enabled state changed or it was
   *  deleted. The Sources route uses this to bump its refresh
   *  nonce so the row list re-pulls. */
  readonly onChanged: () => void;
  /** @internal Test seam — defaults to globalThis.fetch via fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
}

/** Confirmation state for the two destructive actions. `idle` is
 *  the default detail view. `disable` / `enable` / `delete` flip
 *  to a confirmation panel inside the same modal shell. */
type Stage = "idle" | "disable" | "enable" | "delete";

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const FIELD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, max-content) 1fr",
  gap: "var(--space-2) var(--space-4)",
  alignItems: "baseline",
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const VALUE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  color: "var(--fg-1)",
  margin: 0,
  wordBreak: "break-word",
};

const MONO_VALUE_STYLE: CSSProperties = {
  ...VALUE_STYLE,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
};

const URL_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  flexWrap: "wrap",
};

const URL_TEXT_STYLE: CSSProperties = {
  ...MONO_VALUE_STYLE,
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  flex: "1 1 auto",
  minWidth: 0,
  // Override break-word for the URL — UUIDs shouldn't wrap mid-segment.
  wordBreak: "break-all",
};

const COPY_FEEDBACK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
};

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--space-3)",
  marginTop: "var(--space-3)",
};

const DESTRUCTIVE_GROUP_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
};

const CONFIRM_BODY_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

const CONFIRM_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

/** Style for the destructive confirm button — alert red border,
 *  ink fill (admin chrome, not advisory amber). */
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

export function SourceBindingDetail(
  props: SourceBindingDetailProps,
): JSX.Element {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  // Track whether the component is still mounted. The copy-feedback
  // flash uses a setTimeout that we don't want to setState into a
  // detached tree on rapid dismount.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const webhookOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  const webhookUrl = `${webhookOrigin}/webhooks/${props.binding.id}`;

  const handleCopy = async (): Promise<void> => {
    setActionError(null);
    const clip = (
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { clipboard?: { writeText?: (s: string) => Promise<void> } })
            .clipboard
        : undefined
    );
    if (clip?.writeText !== undefined) {
      try {
        await clip.writeText(webhookUrl);
        if (!mountedRef.current) return;
        setCopyState("copied");
        // 1.5s flash, then back to idle. No animation library —
        // just a state-driven re-render of the inline glyph + label.
        window.setTimeout(() => {
          if (mountedRef.current) setCopyState("idle");
        }, 1500);
      } catch {
        // Permission denied or insecure context that resolved
        // `clipboard` but rejected the call. Fall back to the
        // manual hint.
        if (mountedRef.current) setCopyState("manual");
      }
      return;
    }
    // No clipboard API at all (insecure context, locked-down
    // sandbox). Surface the manual hint — the URL itself is
    // already on screen so the operator just selects it.
    setCopyState("manual");
  };

  /** Map a thrown error from `fetchAdmin` to an operator-facing
   *  i18n string (PR-Q10b). Previously the component leaked
   *  `err.message` ("Admin API validation error (HTTP 422)") into
   *  the alert; now structured errors route through `sources.detail.errors.*`
   *  keys and the raw message never reaches the UI.
   *
   *  `defaultKey` is the fallback for unknown errors and for
   *  `ApiValidationError`s without a specific 409 mapping. */
  const mapActionError = (err: unknown, defaultKey: string): string => {
    if (err instanceof ApiAuthError) {
      return t("sources.detail.errors.auth");
    }
    if (err instanceof ApiTransientError) {
      return t("sources.detail.errors.transient");
    }
    // ApiValidationError covers 4xx other than 401/403; the 409
    // fk_restricted path is handled at the call site (DELETE only)
    // before falling back here.
    return t(defaultKey);
  };

  const submitPatch = async (enabled: boolean): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin<{ id: string; enabled: boolean }>(
        `/api/admin/source-bindings/${props.binding.id}`,
        {
          method: "PATCH",
          body: { enabled },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      props.onChanged();
      props.onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      // Default to disable/enable-specific copy so the operator's
      // intent context is preserved in the surfaced message.
      const defaultKey = enabled
        ? "sources.detail.errors.enableFailed"
        : "sources.detail.errors.disableFailed";
      setActionError(mapActionError(err, defaultKey));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const submitDelete = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin<{ deleted: true }>(
        `/api/admin/source-bindings/${props.binding.id}`,
        {
          method: "DELETE",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      props.onChanged();
      props.onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      // The DELETE endpoint returns 409 when an append-only audit
      // FK blocks the cascade. Surface a more specific copy so the
      // operator picks "disable" instead. Everything else routes
      // through the structured-error i18n mapper.
      if (err instanceof ApiValidationError && err.status === 409) {
        setActionError(t("sources.detail.errors.deleteFkRestricted"));
      } else {
        setActionError(
          mapActionError(err, "sources.detail.errors.deleteFailed"),
        );
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const onIdle = (): void => {
    setStage("idle");
    setActionError(null);
  };

  const renderConfirm = (
    title: string,
    body: string,
    confirmLabel: string,
    onConfirm: () => void,
    destructive: boolean,
  ): JSX.Element => (
    <div style={SECTION_STYLE}>
      <h3 style={{ ...VALUE_STYLE, fontWeight: 500 }}>{title}</h3>
      <p style={CONFIRM_BODY_STYLE}>{body}</p>
      {actionError !== null ? (
        <p style={ERROR_TEXT_STYLE} role="alert">
          {actionError}
        </p>
      ) : null}
      <div style={CONFIRM_FOOTER_STYLE}>
        <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
          {t("sources.detail.actions.cancel")}
        </Btn>
        <button
          type="button"
          disabled={submitting}
          onClick={onConfirm}
          style={
            destructive
              ? DESTRUCTIVE_CONFIRM_BTN_STYLE
              : {
                  ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                  background: "var(--ink)",
                  borderColor: "var(--ink)",
                }
          }
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );

  if (stage === "disable") {
    return (
      <Modal
        title={t("sources.detail.actions.confirmDisableTitle")}
        onClose={props.onClose}
        maxWidth={520}
      >
        {renderConfirm(
          t("sources.detail.actions.confirmDisableTitle"),
          t("sources.detail.actions.confirmDisableBody"),
          t("sources.detail.actions.confirmDisable"),
          () => {
            void submitPatch(false);
          },
          false,
        )}
      </Modal>
    );
  }
  if (stage === "enable") {
    return (
      <Modal
        title={t("sources.detail.actions.confirmEnableTitle")}
        onClose={props.onClose}
        maxWidth={520}
      >
        {renderConfirm(
          t("sources.detail.actions.confirmEnableTitle"),
          t("sources.detail.actions.confirmEnableBody"),
          t("sources.detail.actions.confirmEnable"),
          () => {
            void submitPatch(true);
          },
          false,
        )}
      </Modal>
    );
  }
  if (stage === "delete") {
    return (
      <Modal
        title={t("sources.detail.actions.confirmDeleteTitle")}
        onClose={props.onClose}
        maxWidth={560}
      >
        {renderConfirm(
          t("sources.detail.actions.confirmDeleteTitle"),
          t("sources.detail.actions.confirmDeleteBody"),
          t("sources.detail.actions.confirmDelete"),
          () => {
            void submitDelete();
          },
          true,
        )}
      </Modal>
    );
  }

  const pendingCount = props.binding.pendingEventsCount ?? 0;
  const sigFailCount = props.binding.sigFailCount24h ?? 0;

  return (
    <Modal
      title={t("sources.detail.title")}
      subtitle={t("sources.detail.subtitle")}
      onClose={props.onClose}
      maxWidth={620}
    >
      <div style={SECTION_STYLE}>
        {/* Webhook URL — the load-bearing piece of this modal. */}
        <div style={SECTION_STYLE}>
          <span style={LABEL_STYLE}>{t("sources.detail.labels.webhookUrl")}</span>
          <div style={URL_ROW_STYLE}>
            <code style={URL_TEXT_STYLE} data-webhook-url>
              {webhookUrl}
            </code>
            <Btn variant="subtle" onClick={(): void => { void handleCopy(); }}>
              {copyState === "copied"
                ? t("sources.detail.copy.copied")
                : t("sources.detail.copy.copy")}
            </Btn>
          </div>
          {copyState === "copied" ? (
            <span style={COPY_FEEDBACK_STYLE} role="status">
              <GlyphFilledDisc
                size={10}
                title="copied"
                style={{ color: "var(--healthy)" }}
              />
              {t("sources.detail.copy.copied")}
            </span>
          ) : null}
          {copyState === "manual" ? (
            <span style={COPY_FEEDBACK_STYLE} role="status">
              {t("sources.detail.copy.manualHint")}
            </span>
          ) : null}
        </div>

        {/* Field grid — adapter / domain / mode / counts. */}
        <div style={FIELD_GRID_STYLE}>
          <span style={LABEL_STYLE}>{t("sources.detail.labels.bindingId")}</span>
          <span style={MONO_VALUE_STYLE}>{props.binding.id}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.adapter")}</span>
          <span style={VALUE_STYLE}>{props.binding.adapterSlug}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.domain")}</span>
          <span style={VALUE_STYLE}>{props.binding.domainSlug}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.reviewMode")}</span>
          <span style={VALUE_STYLE}>{props.binding.reviewMode}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.enabled")}</span>
          <span style={VALUE_STYLE}>
            {props.binding.enabled ? t("common.yes") : t("common.no")}
          </span>

          <span style={LABEL_STYLE}>
            {t("sources.detail.labels.pendingEvents")}
          </span>
          <span style={MONO_VALUE_STYLE}>{pendingCount}</span>

          <span style={LABEL_STYLE}>
            {t("sources.detail.labels.sigFailures")}
          </span>
          <span style={MONO_VALUE_STYLE}>{sigFailCount}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.lastError")}</span>
          <span style={VALUE_STYLE}>
            {props.binding.lastError ?? t("sources.detail.labels.noLastError")}
          </span>
        </div>

        {actionError !== null ? (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {actionError}
          </p>
        ) : null}

        <div style={ACTION_ROW_STYLE}>
          <Btn variant="ghost" onClick={props.onClose}>
            {t("sources.detail.actions.close")}
          </Btn>
          <div style={DESTRUCTIVE_GROUP_STYLE}>
            <Btn
              variant="subtle"
              onClick={(): void =>
                setStage(props.binding.enabled ? "disable" : "enable")
              }
            >
              {props.binding.enabled
                ? t("sources.detail.actions.disable")
                : t("sources.detail.actions.enable")}
            </Btn>
            <Btn variant="ghost" onClick={(): void => setStage("delete")}>
              {t("sources.detail.actions.delete")}
            </Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}
