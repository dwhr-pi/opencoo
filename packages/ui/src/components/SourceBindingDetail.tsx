/**
 * SourceBindingDetail — Sources row drill-down modal.
 *
 * PR-Q10 (phase-a appendix #9) — view-mode core:
 *   1. "What's the webhook URL I give Asana?" — formatted in
 *      mono with a copy button + healthy-toned confirmation flash
 *      (mirrors `CredentialForm`'s encrypted-note treatment).
 *   2. "Disable / Delete this binding" — both gated by an inline
 *      confirmation step, both routed through the CSRF-protected
 *      admin-API endpoints (PATCH + DELETE).
 *
 * PR-R2 (phase-a appendix #10) — Edit toggle:
 *   3. Operational settings (`bindingConfigSchema`) — fields
 *      rendered with `secret: false`. Save posts
 *      `PATCH {config}`.
 *   4. Rotate credentials (`credentialSchema`) — fields all
 *      empty (we never read existing plaintext); banner clarifies
 *      rotation is atomic + does not pause the binding. Save posts
 *      `PATCH {credentials}`.
 *
 *   When the operator changes BOTH config + credentials in one
 *   edit session, the UI sends TWO sequential PATCHes (config
 *   first, then credentials) — the discriminator on the route
 *   rejects mixed bodies because each intent is one audit verb.
 *
 * Modal shape mirrors `Modal.tsx` + `PatEntryModal.tsx` (the only
 * other admin modals on this surface). Hard-nos honored:
 *   - no gradients, no drop shadows for elevation, no backdrop
 *     blur, no pills (radii cap at 6/10), no emoji
 *   - lowercase `opencoo` in any future copy strings
 *   - copy success uses the filled-disc glyph in `--healthy`,
 *     same as the CredentialForm encrypted-note
 *   - rotation banner is informational (`--ink-3`), NEVER
 *     `--advisory` — that token is reserved for the agent layer.
 *   - `--alert` reserved for destructive surfaces (Disable/Delete).
 *
 * THREAT-MODEL §3.13 — every mutating endpoint is CSRF-gated
 * server-side; the SPA's `fetchAdmin` already mirrors the
 * `opencoo_csrf` cookie as `X-CSRF-Token` for any PATCH/DELETE.
 * The webhook URL itself is the binding's UUID — operators sharing
 * it externally is by design (it is the public webhook target).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { GlyphFilledDisc } from "./Glyph.js";
import { ImpactPreviewDialog } from "./ImpactPreviewDialog.js";
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

/** Modal stage. `idle` is the Q10 detail view; `disable` / `enable`
 *  / `delete` flip to confirmation panels; `edit` (PR-R2) flips to
 *  the operational-settings + credential-rotation form; `forget`
 *  (PR-R7) flips to the impact-preview dialog. */
type Stage = "idle" | "disable" | "enable" | "delete" | "edit" | "forget";

// ─── PR-R2 adapter-descriptor types (mirror NewSourceBindingModal) ───────────

interface CredentialFieldDescriptor {
  readonly type: "string";
  readonly description?: string;
  readonly secret?: boolean;
}

interface PollingCredentialSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CredentialFieldDescriptor>>;
  readonly required: readonly string[];
}

interface WebhookCredentialSchema {
  readonly type: "object";
  readonly properties: {
    readonly auth: PollingCredentialSchema;
    readonly webhook_secret: PollingCredentialSchema;
  };
  readonly required: readonly ("auth" | "webhook_secret")[];
}

type AnyCredentialSchema = PollingCredentialSchema | WebhookCredentialSchema;

interface BindingConfigField {
  readonly type: "string" | "number" | "boolean" | "array";
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly default?: string | number | boolean | readonly string[];
  readonly items?: { readonly type: "string" };
  readonly minLength?: number;
  readonly hidden?: boolean;
}

interface BindingConfigSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, BindingConfigField>>;
  readonly required: readonly string[];
}

interface AdapterDescriptor {
  readonly slug: string;
  readonly mode: "polling" | "webhook";
  readonly credentialSchema: AnyCredentialSchema;
  readonly bindingConfigSchema?: BindingConfigSchema;
}

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

// ─── PR-W4 (phase-a appendix #14) — Intake state panel styles ──────────────

const INTAKE_PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  paddingTop: "var(--space-3)",
  borderTop: "1px solid var(--rule)",
};

const INTAKE_COUNTS_GRID_STYLE: CSSProperties = {
  display: "grid",
  // 4 equal columns for the 4 statuses — narrow enough that the labels
  // fit on a single line without wrapping mid-word.
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: "var(--space-3)",
};

const INTAKE_COUNT_TILE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
};

const INTAKE_COUNT_TILE_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const INTAKE_COUNT_TILE_VALUE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-display)",
  lineHeight: 1,
  color: "var(--fg-1)",
};

/** Failure-tile value carries the alert tone so the operator's eye
 *  jumps to it across the four counts. Falls back to the neutral fg-1
 *  on zero so a healthy binding doesn't paint red.
 *  (Per design-system rules `--alert` is reserved for destructive /
 *  flagged items — a non-zero failed-count IS exactly that.) */
const INTAKE_COUNT_TILE_VALUE_FAILED_STYLE: CSSProperties = {
  ...INTAKE_COUNT_TILE_VALUE_STYLE,
  color: "var(--alert)",
};

const INTAKE_FAILED_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const INTAKE_FAILED_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
};

const INTAKE_FAILED_ROW_CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--alert)",
  border: "1px solid var(--alert)",
  borderRadius: "var(--radius-s)",
  padding: "2px 6px",
  flexShrink: 0,
};

const INTAKE_FAILED_ROW_SNIPPET_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-2)",
  flex: "1 1 auto",
  minWidth: 0,
  // Snippet may carry punctuation/spaces; break-word lets long single
  // tokens wrap so the row's right-edge Retry button doesn't get
  // pushed off the modal at 200-char snippet widths.
  wordBreak: "break-word",
  margin: 0,
};

const INTAKE_FAILED_ROW_ID_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--fg-3)",
  flexShrink: 0,
};

/** Retry button — PR-W4 ships it DISABLED with a tooltip that
 *  references PR-W2 (the per-job retry endpoint). The operator sees
 *  the affordance and knows it lands soon; W2 wires it. */
const INTAKE_RETRY_BTN_STYLE: CSSProperties = {
  background: "var(--paper-2)",
  color: "var(--fg-3)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-1) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  cursor: "not-allowed",
  flexShrink: 0,
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

/** PR-R2 — edit-mode chrome. */
const EDIT_SECTION_HEADING_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  margin: 0,
  paddingTop: "var(--space-2)",
};

const EDIT_SECTION_SUBTITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--fg-3)",
  margin: 0,
};

/** Rotation banner — INFORMATIONAL (`--ink-3`). Never `--advisory`
 *  (advisory is reserved for the agent layer per design-system rules)
 *  and never `--alert` (alert is destructive only). */
const ROTATION_BANNER_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--ink-3)",
  margin: 0,
  padding: "var(--space-3) var(--space-4)",
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
};

const EDIT_FIELDS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const EDIT_FIELD_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const EDIT_FIELD_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const EDIT_FIELD_INPUT_STYLE: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
  width: "100%",
};

const EDIT_FIELD_INPUT_ERROR_STYLE: CSSProperties = {
  ...EDIT_FIELD_INPUT_STYLE,
  borderColor: "var(--alert)",
};

const EDIT_FIELD_DESCRIPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--fg-3)",
  margin: 0,
};

const EDIT_FIELD_ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
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

/** PR-Z3 (phase-a appendix #12) — "Scan now" button disabled-window
 *  in ms. Prevents the operator from spamming the endpoint while a
 *  scan is in flight. The server doesn't rate-limit `:id/scan-now`
 *  in v0.1 (a per-binding cooldown is parked at v0.2 per the
 *  wave-12 scoping doc); this client-side gate is the only
 *  protection from accidental fork-bombing. 3s is generous enough
 *  for the operator to see the toast + short enough that a real
 *  retry click after the toast clears succeeds. */
const SCAN_NOW_DISABLE_MS = 3000;

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
  /** PR-Z3 — "Scan now" feedback state. `queued` flashes the success
   *  toast; `cooldown` keeps the button disabled for
   *  `SCAN_NOW_DISABLE_MS`. */
  const [scanNowState, setScanNowState] = useState<
    "idle" | "queued" | "cooldown"
  >("idle");
  // PR-R2 edit-mode state. The descriptor is fetched on demand (the
  // first time the operator opens edit mode) and cached for the
  // lifetime of the modal.
  const [adapterDescriptor, setAdapterDescriptor] =
    useState<AdapterDescriptor | null>(null);
  const [adapterFetchError, setAdapterFetchError] = useState<string | null>(
    null,
  );
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [credentialValues, setCredentialValues] = useState<
    Record<string, string>
  >({});
  // Per-field validation errors. Keys mirror the input keys
  // (e.g. `projectGid`, `auth.personal_access_token`).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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

  /** PR-Z3 (phase-a appendix #12) — POST `:id/scan-now`. Closes G8.
   *
   *  Success path:
   *    1. POST → 202 with `{enqueued: true, jobId}`.
   *    2. Flash a `--healthy` toast for ~3s ("Scan queued; see
   *       Activity tab").
   *    3. Disable the button for `SCAN_NOW_DISABLE_MS` to prevent
   *       operator-spam (the server doesn't rate-limit yet — v0.2
   *       follow-up per the wave-12 scoping doc).
   *
   *  Error paths route through the existing `mapActionError` /
   *  i18n machinery for consistency with the other PATCH/DELETE
   *  actions:
   *    - 409 (`binding_disabled`)         → "Enable the binding…"
   *    - 503 (`scanner_queue_unavailable`)→ "Scanner queue is not wired…"
   *    - 5xx / network                    → generic "Could not queue…"
   */
  const submitScanNow = async (): Promise<void> => {
    setActionError(null);
    setScanNowState("cooldown");
    try {
      await fetchAdmin<{ enqueued: boolean; jobId: string }>(
        `/api/admin/source-bindings/${props.binding.id}/scan-now`,
        {
          method: "POST",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      setScanNowState("queued");
      // Hold the cooldown (button disabled) + toast for the full
      // window so the operator can't fire 5 scans before the first
      // success message lands. After the window, drop both back to
      // idle in one render so the button re-enables alongside the
      // toast clearing.
      window.setTimeout(() => {
        if (mountedRef.current) setScanNowState("idle");
      }, SCAN_NOW_DISABLE_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      // Reset cooldown so the operator can retry immediately on
      // error — the request didn't actually queue anything, so the
      // anti-spam reasoning doesn't apply.
      setScanNowState("idle");
      // Map the structured error to the right i18n string. The
      // route emits 409 with `error: 'binding_disabled'` when the
      // binding's `enabled = false`; surface a more specific copy
      // so the operator picks "Enable" instead of retrying. 503 is
      // a composition-incomplete signal (scanner queue not wired);
      // everything else routes through the generic scanNowFailed
      // copy.
      if (err instanceof ApiValidationError && err.status === 409) {
        setActionError(t("sources.detail.scanNow.disabled"));
        return;
      }
      if (err instanceof ApiTransientError && err.status === 503) {
        setActionError(t("sources.detail.errors.scanNowUnavailable"));
        return;
      }
      setActionError(mapActionError(err, "sources.detail.errors.scanNowFailed"));
    }
  };

  /** PR-W2 (phase-a appendix #14) — "Retry failed jobs" state.
   *  Mirrors the Scan-now pattern but without the cooldown — the
   *  bulk retry can legitimately enqueue many jobs and a 3s
   *  re-click protection is unnecessary (server is idempotent on
   *  the no-failed-jobs path).
   *
   *  `queued` flashes the success toast with the retried count; the
   *  count is recorded in state so the toast can render it without
   *  re-querying. The toast auto-clears after `SCAN_NOW_DISABLE_MS`
   *  (reuses the same constant for visual consistency with the
   *  Scan-now success flash). */
  const [retryFailedState, setRetryFailedState] = useState<
    "idle" | "in-flight" | "queued"
  >("idle");
  const [retryFailedCount, setRetryFailedCount] = useState<number | null>(null);

  const submitRetryFailed = async (): Promise<void> => {
    setActionError(null);
    setRetryFailedState("in-flight");
    try {
      const body = await fetchAdmin<{ retriedCount: number }>(
        `/api/admin/source-bindings/${props.binding.id}/retry-failed`,
        {
          method: "POST",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      setRetryFailedCount(body.retriedCount);
      setRetryFailedState("queued");
      window.setTimeout(() => {
        if (mountedRef.current) {
          setRetryFailedState("idle");
          setRetryFailedCount(null);
        }
      }, SCAN_NOW_DISABLE_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      setRetryFailedState("idle");
      // 503 → composition-incomplete (classify queue not wired).
      // Mirror the scan-now mapping so the operator gets a specific
      // copy instead of the generic transient message.
      if (err instanceof ApiTransientError && err.status === 503) {
        setActionError(t("sources.detail.errors.retryFailedUnavailable"));
        return;
      }
      setActionError(
        mapActionError(err, "sources.detail.errors.retryFailedFailed"),
      );
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

  /** Return to view mode and scrub edit-mode form state. We reset
   *  `configValues` to the persisted seed and CLEAR `credentialValues`
   *  to `{}` so typed plaintext (especially secrets) doesn't sit in
   *  React component state across Cancel and a re-entered Edit. The
   *  modal stays mounted between Cancel and a re-Edit click — closing
   *  this leak window is the security fix (PR-R2 second Copilot
   *  fix-up). The `initialConfigSeed` memo already mirrors the open-
   *  time seed so reusing it keeps the reset consistent. */
  const onIdle = (): void => {
    setStage("idle");
    setActionError(null);
    setFieldErrors({});
    setConfigValues(initialConfigSeed);
    setCredentialValues({});
  };

  /** Clear a single keyed entry from `fieldErrors` if present. Called
   *  from the config + credentials onChange handlers so a 422-flagged
   *  input drops its error as soon as the operator starts editing it. */
  const clearFieldError = (key: string): void => {
    if (fieldErrors[key] === undefined) return;
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // ─── PR-R2: edit-mode helpers ────────────────────────────────────────────

  /** Open the edit panel. The first call lazy-loads the adapter
   *  descriptor so we know which form fields to render. */
  const openEdit = async (): Promise<void> => {
    setActionError(null);
    setFieldErrors({});
    setStage("edit");
    if (adapterDescriptor !== null) return;
    try {
      const resp = await fetchAdmin<{
        adapters: readonly AdapterDescriptor[];
      }>("/api/admin/adapters", fetchOptsFor(props.fetchImpl));
      const found = resp.adapters.find(
        (a) => a.slug === props.binding.adapterSlug,
      );
      if (!mountedRef.current) return;
      if (found === undefined) {
        setAdapterFetchError(t("sourceBindingDetail.edit.errors.transient"));
        return;
      }
      setAdapterDescriptor(found);
      // Pre-seed the config form. Priority: binding's persisted
      // config value → schema default. If the binding row carries
      // `config` (admin-API GET surfaces it as of PR-R2), prefer
      // those values so the operator edits on top of reality —
      // unchanged fields will be re-sent on Save and the route's
      // jsonb-replace semantics preserve them.
      setConfigValues(seedConfigFromBinding(found, props.binding.config));
    } catch (err) {
      if (!mountedRef.current) return;
      setAdapterFetchError(
        err instanceof Error
          ? mapActionError(err, "sourceBindingDetail.edit.errors.transient")
          : t("sourceBindingDetail.edit.errors.transient"),
      );
    }
  };

  const initialConfigSeed = useMemo<Record<string, string>>(() => {
    if (adapterDescriptor === null) return {};
    return seedConfigFromBinding(adapterDescriptor, props.binding.config);
    // The binding's persisted config is the seed; identity stable.
  }, [adapterDescriptor, props.binding.config]);

  /** Compute whether the operator has touched the config section. */
  const configChanged = useMemo<boolean>(() => {
    const keys = new Set([
      ...Object.keys(initialConfigSeed),
      ...Object.keys(configValues),
    ]);
    for (const k of keys) {
      if ((configValues[k] ?? "") !== (initialConfigSeed[k] ?? "")) {
        return true;
      }
    }
    return false;
  }, [configValues, initialConfigSeed]);

  /** Per-section dirty state — keys mirror the input keys (see
   *  `renderCredentialFields`): polling adapters use flat keys
   *  (no prefix); webhook adapters split into `auth.<field>` and
   *  `webhook_secret.<field>`.
   *
   *  PR-R2 review fix-up — partial-rotation aware. The route now
   *  accepts `{credentials: { auth?, webhook_secret? }}`, so we
   *  emit only the half(ves) the operator actually edited. */
  const authDirty = useMemo<boolean>(() => {
    if (adapterDescriptor === null) return false;
    if (adapterDescriptor.mode === "polling") {
      return Object.values(credentialValues).some((v) => v.length > 0);
    }
    for (const [key, value] of Object.entries(credentialValues)) {
      if (key.startsWith("auth.") && value.length > 0) return true;
    }
    return false;
  }, [adapterDescriptor, credentialValues]);

  const webhookSecretDirty = useMemo<boolean>(() => {
    if (adapterDescriptor === null) return false;
    if (adapterDescriptor.mode === "polling") return false;
    for (const [key, value] of Object.entries(credentialValues)) {
      if (key.startsWith("webhook_secret.") && value.length > 0) return true;
    }
    return false;
  }, [adapterDescriptor, credentialValues]);

  const credentialsChanged = useMemo<boolean>(
    () => authDirty || webhookSecretDirty,
    [authDirty, webhookSecretDirty],
  );

  /** Build the `config` body the route accepts. The route's UPDATE
   *  is a full jsonb REPLACE, so we emit the COMPLETE current state
   *  (operator edits + seeded defaults / persisted unchanged values).
   *  Anything the binding-list endpoint surfaced via `binding.config`
   *  was already pre-seeded into `configValues` on `openEdit()`, so
   *  this is just a coerce-to-schema-shape pass.
   *
   *  Coerces string-keyed input values into the schema-declared
   *  shape (boolean / number / array). Fields the operator cleared
   *  (current.length === 0) are omitted so a blanked input doesn't
   *  collapse to `""` in jsonb — adapter Zod schemas reject empty
   *  strings on required fields. */
  const buildConfigBody = (): Record<string, unknown> => {
    if (adapterDescriptor === null) return {};
    const schema = adapterDescriptor.bindingConfigSchema;
    if (schema === undefined) return {};
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      if (field.hidden === true) continue;
      // PR-R2 review fix-up — distinguish "operator never touched
      // the field" (omit) from "operator typed and then cleared it"
      // (emit a typed empty value so the route's required-gate fires
      // with a path-level diagnostic instead of silently dropping
      // the field). Tracking dirtiness for arrays is the load-bearing
      // case: a required array with all entries deleted previously
      // disappeared from the body and the route accepted it.
      const wasTyped = configValues[key] !== undefined;
      const current = configValues[key] ?? defaultAsRaw(field);
      if (current === undefined) continue;
      if (field.type === "boolean") {
        if (current.length === 0) continue;
        out[key] = current === "true";
      } else if (field.type === "number") {
        if (current.length === 0) continue;
        const n = Number(current);
        if (Number.isFinite(n)) out[key] = n;
      } else if (field.type === "array") {
        const items = current
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length === 0 && !wasTyped) continue;
        // Operator typed-then-cleared OR seeded value emptied — emit
        // an explicit empty array so the route's required-array
        // validator surfaces a 422 instead of accepting a silent drop.
        out[key] = items;
      } else {
        if (current.length === 0) continue;
        out[key] = current;
      }
    }
    return out;
  };

  /** Build the `credentials` body — partial-rotation aware. Returns
   *  `{auth?, webhook_secret?}` containing only the half(ves) the
   *  operator actually edited (see `authDirty` / `webhookSecretDirty`).
   *
   *  Polling adapters: the route's `auth` half IS the flat credentials
   *  object the schema describes — we emit `{auth: {...}}` so the
   *  server's polling-mode validator can find it under the same key.
   *  (The route rejects `webhook_secret` for polling adapters with 422
   *  `webhook_secret_not_supported`.) */
  const buildCredentialsBody = (): Record<string, unknown> => {
    if (adapterDescriptor === null) return {};
    const out: Record<string, unknown> = {};
    if (adapterDescriptor.mode === "polling") {
      if (!authDirty) return out;
      const schema = adapterDescriptor.credentialSchema as PollingCredentialSchema;
      const auth: Record<string, string> = {};
      for (const k of Object.keys(schema.properties)) {
        const v = credentialValues[k] ?? "";
        // Always include even an empty entry so a partially-typed
        // form still surfaces the route's path-only 422 diagnostic.
        auth[k] = v;
      }
      out["auth"] = auth;
      return out;
    }
    const webhook = adapterDescriptor.credentialSchema as WebhookCredentialSchema;
    if (authDirty) {
      const auth: Record<string, string> = {};
      for (const k of Object.keys(webhook.properties.auth.properties)) {
        auth[k] = credentialValues[`auth.${k}`] ?? "";
      }
      out["auth"] = auth;
    }
    if (webhookSecretDirty) {
      const webhookSecret: Record<string, string> = {};
      for (const k of Object.keys(webhook.properties.webhook_secret.properties)) {
        webhookSecret[k] = credentialValues[`webhook_secret.${k}`] ?? "";
      }
      out["webhook_secret"] = webhookSecret;
    }
    return out;
  };

  /** Map a 422 validation response into per-field errors keyed by the
   *  same input keys the form uses. The route's 422 payload includes
   *  a `missing: string[]` of dot-prefixed paths (e.g.
   *  `auth.personal_access_token` for credentials, plain key names for
   *  config), so we can plug each path straight into the inline-error
   *  state without remapping. */
  const apply422FieldErrors = (
    err: unknown,
    fallbackI18nKey: string,
  ): void => {
    if (err instanceof ApiValidationError && err.status === 422) {
      const body = err.body as { error?: unknown; missing?: unknown } | undefined;
      // Specific 422 codes from the route's partial-rotation
      // validator (PR-R2 review fix-up). Each maps to its own
      // operator-facing string.
      if (body?.error === "credentials_empty") {
        setActionError(t("sourceBindingDetail.edit.errors.credentialsEmpty"));
        return;
      }
      if (body?.error === "webhook_secret_not_supported") {
        setActionError(
          t("sourceBindingDetail.edit.errors.webhookSecretNotSupported"),
        );
        return;
      }
      const missing = Array.isArray(body?.missing)
        ? (body!.missing as unknown[]).filter(
            (m): m is string => typeof m === "string",
          )
        : [];
      if (missing.length > 0) {
        // REPLACE the entire error map with the new diagnostic
        // (PR-R2 second Copilot fix-up). Previously this merged
        // `{ ...fieldErrors, [path]: ... }` from a closure-captured
        // `fieldErrors`, which preserved stale errors from a prior
        // attempt for fields the operator never re-touched. The
        // server's 422 response is authoritative for the current
        // body — anything not in `missing` is no longer wrong.
        const fe: Record<string, string> = {};
        for (const path of missing) {
          fe[path] = t("sources.create.errors.requiredField");
        }
        setFieldErrors(fe);
        setActionError(t(fallbackI18nKey));
        return;
      }
    }
    if (err instanceof ApiAuthError) {
      setActionError(t("sourceBindingDetail.edit.errors.auth"));
      return;
    }
    if (err instanceof ApiTransientError) {
      setActionError(t("sourceBindingDetail.edit.errors.transient"));
      return;
    }
    setActionError(t(fallbackI18nKey));
  };

  const submitEdit = async (): Promise<void> => {
    // PR-R2 second Copilot fix-up — do NOT pre-clear `fieldErrors`
    // here. The previous flow was `setFieldErrors({})` → fetch →
    // `apply422FieldErrors` merging from a closure-captured
    // `fieldErrors`, which raced because React's state update was
    // async; the closure could still see stale errors and preserve
    // them. The new flow: leave the prior errors in place during
    // the in-flight request, then on response REPLACE the map
    // wholesale (422) or CLEAR it (200). The result reflects the
    // latest server diagnostic only.
    setActionError(null);
    setSubmitting(true);
    let configOk = true;
    try {
      // Send config first, then credentials, when both changed —
      // the discriminator on the route rejects mixed bodies, so
      // this is two sequential PATCHes (one verb per audit row).
      if (configChanged) {
        try {
          await fetchAdmin<{ id: string }>(
            `/api/admin/source-bindings/${props.binding.id}`,
            {
              method: "PATCH",
              body: { config: buildConfigBody() },
              ...fetchOptsFor(props.fetchImpl),
            },
          );
          if (!mountedRef.current) return;
          // Success on the config PATCH — drop any stale field
          // errors before the credentials PATCH (or the success
          // exit) renders.
          setFieldErrors({});
          props.onChanged();
        } catch (err) {
          if (!mountedRef.current) return;
          configOk = false;
          apply422FieldErrors(
            err,
            "sourceBindingDetail.edit.errors.configFailed",
          );
        }
      }
      if (configOk && credentialsChanged) {
        try {
          await fetchAdmin<{ id: string; credentialsRotatedAt: string }>(
            `/api/admin/source-bindings/${props.binding.id}`,
            {
              method: "PATCH",
              body: { credentials: buildCredentialsBody() },
              ...fetchOptsFor(props.fetchImpl),
            },
          );
          if (!mountedRef.current) return;
          // Success on the credentials PATCH — drop any stale
          // field errors so the operator returns to a clean view.
          setFieldErrors({});
          props.onChanged();
        } catch (err) {
          if (!mountedRef.current) return;
          apply422FieldErrors(
            err,
            "sourceBindingDetail.edit.errors.credentialsFailed",
          );
          return;
        }
      }
      // Only return to view mode if no errors landed.
      if (mountedRef.current && configOk) {
        // Surface success by returning to idle; the parent's
        // refresh nonce already bumped via onChanged().
        setStage("idle");
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  // Body + actions are rendered separately so the actions slot
  // can be passed to <Modal actions={…}> for sticky-bottom behavior
  // (PR-W5 / phase-a appendix #11). Returning a {body, actions}
  // tuple keeps the call sites readable.
  const renderConfirm = (
    title: string,
    body: string,
    confirmLabel: string,
    onConfirm: () => void,
    destructive: boolean,
  ): { body: JSX.Element; actions: JSX.Element } => ({
    body: (
      <div style={SECTION_STYLE}>
        <h3 style={{ ...VALUE_STYLE, fontWeight: 500 }}>{title}</h3>
        <p style={CONFIRM_BODY_STYLE}>{body}</p>
        {actionError !== null ? (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    ),
    actions: (
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
    ),
  });

  if (stage === "disable") {
    const confirm = renderConfirm(
      t("sources.detail.actions.confirmDisableTitle"),
      t("sources.detail.actions.confirmDisableBody"),
      t("sources.detail.actions.confirmDisable"),
      () => {
        void submitPatch(false);
      },
      false,
    );
    return (
      <Modal
        title={t("sources.detail.actions.confirmDisableTitle")}
        onClose={props.onClose}
        maxWidth={520}
        actions={confirm.actions}
      >
        {confirm.body}
      </Modal>
    );
  }
  if (stage === "enable") {
    const confirm = renderConfirm(
      t("sources.detail.actions.confirmEnableTitle"),
      t("sources.detail.actions.confirmEnableBody"),
      t("sources.detail.actions.confirmEnable"),
      () => {
        void submitPatch(true);
      },
      false,
    );
    return (
      <Modal
        title={t("sources.detail.actions.confirmEnableTitle")}
        onClose={props.onClose}
        maxWidth={520}
        actions={confirm.actions}
      >
        {confirm.body}
      </Modal>
    );
  }
  if (stage === "delete") {
    const confirm = renderConfirm(
      t("sources.detail.actions.confirmDeleteTitle"),
      t("sources.detail.actions.confirmDeleteBody"),
      t("sources.detail.actions.confirmDelete"),
      () => {
        void submitDelete();
      },
      true,
    );
    return (
      <Modal
        title={t("sources.detail.actions.confirmDeleteTitle")}
        onClose={props.onClose}
        maxWidth={560}
        actions={confirm.actions}
      >
        {confirm.body}
      </Modal>
    );
  }
  if (stage === "forget") {
    // PR-R7 — the ImpactPreviewDialog manages its own modal shell;
    // we just hand it the binding-id + close/refresh callbacks. On
    // confirm it bumps the parent's refresh nonce + closes the
    // outer modal so the operator returns to the Sources list.
    return (
      <ImpactPreviewDialog
        bindingId={props.binding.id}
        onClose={props.onClose}
        onConfirmed={props.onChanged}
        {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
      />
    );
  }
  if (stage === "edit") {
    return (
      <Modal
        title={t("sourceBindingDetail.edit.title")}
        subtitle={t("sourceBindingDetail.edit.subtitle")}
        onClose={props.onClose}
        maxWidth={620}
        actions={
          <div style={CONFIRM_FOOTER_STYLE}>
            <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
              {t("sourceBindingDetail.edit.cancel")}
            </Btn>
            <button
              type="button"
              disabled={submitting}
              onClick={(): void => {
                void submitEdit();
              }}
              style={{
                ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                background: submitting ? "var(--ink-3)" : "var(--ink)",
                borderColor: submitting ? "var(--ink-3)" : "var(--ink)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting
                ? t("sourceBindingDetail.edit.saving")
                : t("sourceBindingDetail.edit.save")}
            </button>
          </div>
        }
      >
        <div style={SECTION_STYLE}>
          {/* Operational settings section. */}
          <div style={EDIT_FIELDS_STYLE}>
            <h3 style={EDIT_SECTION_HEADING_STYLE}>
              {t("sourceBindingDetail.edit.config.title")}
            </h3>
            <p style={EDIT_SECTION_SUBTITLE_STYLE}>
              {t("sourceBindingDetail.edit.config.subtitle")}
            </p>
            {adapterDescriptor === null ? (
              adapterFetchError !== null ? (
                <p style={ERROR_TEXT_STYLE} role="alert">
                  {adapterFetchError}
                </p>
              ) : null
            ) : adapterDescriptor.bindingConfigSchema === undefined ? null : (
              <>
                {Object.entries(
                  adapterDescriptor.bindingConfigSchema.properties,
                ).map(([key, field]) => {
                  if (field.hidden === true) return null;
                  return (
                    <EditField
                      key={key}
                      testId={`edit-config-${key}`}
                      label={key}
                      {...(field.description !== undefined
                        ? { description: field.description }
                        : {})}
                      value={configValues[key] ?? ""}
                      onChange={(v): void => {
                        setConfigValues((cur) => ({ ...cur, [key]: v }));
                        clearFieldError(key);
                      }}
                      {...(fieldErrors[key] !== undefined
                        ? { error: fieldErrors[key] as string }
                        : {})}
                    />
                  );
                })}
              </>
            )}
          </div>

          {/* Rotate credentials section. */}
          <div style={EDIT_FIELDS_STYLE}>
            <h3 style={EDIT_SECTION_HEADING_STYLE}>
              {t("sourceBindingDetail.edit.credentials.title")}
            </h3>
            <p style={EDIT_SECTION_SUBTITLE_STYLE}>
              {t("sourceBindingDetail.edit.credentials.subtitle")}
            </p>
            <p
              style={ROTATION_BANNER_STYLE}
              data-testid="rotation-banner"
            >
              {t("sourceBindingDetail.edit.credentials.banner")}
            </p>
            {adapterDescriptor === null
              ? null
              : renderCredentialFields({
                  descriptor: adapterDescriptor,
                  values: credentialValues,
                  errors: fieldErrors,
                  onChange: (key, v): void => {
                    setCredentialValues((cur) => ({ ...cur, [key]: v }));
                    clearFieldError(key);
                  },
                })}
          </div>

          {actionError !== null ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
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
      actions={
        <div style={ACTION_ROW_STYLE}>
          <Btn variant="ghost" onClick={props.onClose}>
            {t("sources.detail.actions.close")}
          </Btn>
          <div style={DESTRUCTIVE_GROUP_STYLE}>
            {/* PR-Z3 (phase-a appendix #12) — "Scan now". Closes G8.
             *  Disabled for `SCAN_NOW_DISABLE_MS` after a successful
             *  click so consecutive operator-clicks don't fork-bomb
             *  the scanner queue (the server doesn't rate-limit yet —
             *  v0.2 follow-up). The button is also disabled while the
             *  binding is `enabled: false` — the server returns 409,
             *  but disabling client-side gives the operator a clear
             *  affordance instead of a fired-and-failed click. */}
            <Btn
              variant="subtle"
              disabled={
                scanNowState === "cooldown" ||
                scanNowState === "queued" ||
                !props.binding.enabled
              }
              onClick={(): void => {
                void submitScanNow();
              }}
            >
              {t("sources.detail.actions.scanNow")}
            </Btn>
            {/* PR-W2 (phase-a appendix #14) — Retry failed jobs.
             *  Re-enqueues the BullMQ failed-set jobs for this binding
             *  after the operator has fixed `allowed_paths` (W1) and
             *  intake_status='failed' (W3) showed them which jobs are
             *  stuck. The button is disabled while the request is in
             *  flight (avoids double-fire) and when the binding is
             *  disabled (the route accepts the call but the re-enqueued
             *  job would no-op until the binding is re-enabled —
             *  surface the affordance up front).
             *
             *  W2 ships ONLY the per-binding bulk button. The per-row
             *  Retry buttons described in the W4 surface are gated on
             *  PR-W4 landing first (intake-state panel introduces the
             *  failed-rows list); a follow-up wires the `?intakeId=`
             *  query-param call. */}
            <Btn
              variant="subtle"
              disabled={
                retryFailedState !== "idle" || !props.binding.enabled
              }
              onClick={(): void => {
                void submitRetryFailed();
              }}
            >
              {t("sources.detail.actions.retryFailed")}
            </Btn>
            <Btn
              variant="subtle"
              onClick={(): void => {
                void openEdit();
              }}
            >
              {t("sourceBindingDetail.edit.open")}
            </Btn>
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
            {/* PR-R7 — Forget source: opens the impact preview dialog.
             *  Sits between Disable and Delete in the destructive
             *  group; the impact dialog itself carries the `--alert`
             *  destructive Confirm button (this trigger is a neutral
             *  ghost that delegates to the dialog). */}
            <Btn variant="ghost" onClick={(): void => setStage("forget")}>
              {t("sources.detail.actions.forget")}
            </Btn>
            <Btn variant="ghost" onClick={(): void => setStage("delete")}>
              {t("sources.detail.actions.delete")}
            </Btn>
          </div>
        </div>
      }
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

        {/* PR-W1 (phase-a appendix #14) — allowed_paths chip list +
         *  Edit affordance. Hidden when the binding's allowed_paths
         *  field is undefined on older fixtures; otherwise renders
         *  the chips (empty array surfaces an empty chip row plus
         *  the Edit button so the operator can fix it without
         *  dropping to SQL). Renders BEFORE the Intake state panel
         *  so the operator's eye moves "config → outcome" as they
         *  scan the modal. */}
        <AllowedPathsPanel
          binding={props.binding}
          onChanged={props.onChanged}
          fetchImpl={props.fetchImpl}
        />

        {/* PR-W5-UI (phase-a appendix #15) — retention-override + notes
         *  editors. Both PATCH the same `/api/admin/source-bindings/:id`
         *  endpoint via the W5 API branches (`retention_days_override`
         *  + `notes`). Each panel owns its own draft / submit state. */}
        <RetentionOverridePanel
          binding={props.binding}
          onChanged={props.onChanged}
          fetchImpl={props.fetchImpl}
        />
        <NotesPanel
          binding={props.binding}
          onChanged={props.onChanged}
          fetchImpl={props.fetchImpl}
        />

        {/* PR-W4 (phase-a appendix #14) — Intake state panel. Renders
         *  the four per-status `intakeCounts` (defaulted to 0 for
         *  back-compat) and the most-recent 3 `failed` rows. The
         *  Retry button is intentionally disabled in W4 — the
         *  per-job retry endpoint ships in PR-W2; the affordance
         *  surfaces here so the operator sees the path forward. */}
        <IntakeStatePanel binding={props.binding} />

        {actionError !== null ? (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {actionError}
          </p>
        ) : null}

        {/* PR-Z3 (phase-a appendix #12) — "Scan now" success toast.
         *  Reuses the same `--healthy` filled-disc glyph the copy
         *  feedback uses so the operator gets a consistent
         *  "this worked" signal across the modal. Hidden in idle
         *  and cooldown-only states; visible only after a successful
         *  202 lands. The button stays disabled until the cooldown
         *  window expires (which clears `scanNowState` back to idle
         *  in one render). */}
        {scanNowState === "queued" ? (
          <span
            style={COPY_FEEDBACK_STYLE}
            role="status"
            data-testid="scan-now-success"
          >
            <GlyphFilledDisc
              size={10}
              title="queued"
              style={{ color: "var(--healthy)" }}
            />
            {t("sources.detail.scanNow.success")}
          </span>
        ) : null}
        {/* PR-W2 (phase-a appendix #14) — Retry-failed success toast.
         *  Reuses the healthy filled-disc glyph and copy-feedback row
         *  for visual consistency with the Scan-now and copy-URL
         *  flashes. Renders the retried_count so the operator sees
         *  the scale of the action (zero is still surfaced — the
         *  idempotent no-op path also acknowledges the click). */}
        {retryFailedState === "queued" && retryFailedCount !== null ? (
          <span
            style={COPY_FEEDBACK_STYLE}
            role="status"
            data-testid="retry-failed-success"
          >
            <GlyphFilledDisc
              size={10}
              title="retried"
              style={{ color: "var(--healthy)" }}
            />
            {t("sources.detail.retryFailed.success", {
              count: retryFailedCount,
            })}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

/** Local field renderer (NOT CredentialForm.tsx). The edit panel
 *  needs controlled values that span config + credentials and a
 *  single submit handler routing through the discriminated PATCH;
 *  CredentialForm is self-contained with its own form/submit and
 *  doesn't expose a controlled mode. Refactoring CredentialForm
 *  to a controlled variant is a v0.2 design-system extraction.
 *
 *  Render an editable text input + helper + per-field error. The
 *  input id mirrors the field key so both `data-testid` queries
 *  and accessible label-for relationships work. */
interface EditFieldProps {
  readonly testId: string;
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly error?: string;
  readonly secret?: boolean;
}

function EditField(props: EditFieldProps): JSX.Element {
  const inputStyle =
    props.error !== undefined
      ? EDIT_FIELD_INPUT_ERROR_STYLE
      : EDIT_FIELD_INPUT_STYLE;
  return (
    <div style={EDIT_FIELD_ROW_STYLE}>
      <label
        htmlFor={props.testId}
        style={EDIT_FIELD_LABEL_STYLE}
      >
        {props.label}
      </label>
      {props.description !== undefined ? (
        <p style={EDIT_FIELD_DESCRIPTION_STYLE}>{props.description}</p>
      ) : null}
      <input
        id={props.testId}
        data-testid={props.testId}
        type={props.secret === true ? "password" : "text"}
        autoComplete={props.secret === true ? "new-password" : "off"}
        style={inputStyle}
        value={props.value}
        onChange={(e): void => props.onChange(e.target.value)}
      />
      {props.error !== undefined ? (
        <p
          style={EDIT_FIELD_ERROR_STYLE}
          data-testid={`${props.testId}-error`}
          role="alert"
        >
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** Coerce a persisted-config value (anything jsonb gives us) into
 *  the same string form `configValues` uses for the input element.
 *  Schema decides the input shape; runtime values may be of any
 *  matching type. Falls back to `String(v)` for unknown shapes
 *  rather than throwing — the field renders empty input would be a
 *  worse UX than showing the literal. */
function coercePersistedToRaw(
  field: BindingConfigField,
  value: unknown,
): string {
  if (value === null) return "";
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
  }
  if (field.type === "number") {
    return String(value);
  }
  if (field.type === "array") {
    if (Array.isArray(value)) {
      return value
        .filter((v): v is string => typeof v === "string")
        .join(", ");
    }
    return String(value);
  }
  // string (with or without enum).
  if (typeof value === "string") return value;
  return String(value);
}

/** Coerce a schema-declared default into the same string form
 *  `configValues` uses (booleans → "true"/"false"; numbers →
 *  String(n); arrays → CSV). Mirrors the helper in
 *  NewSourceBindingModal. */
function defaultAsRaw(field: BindingConfigField): string | undefined {
  if (field.default === undefined) return undefined;
  if (typeof field.default === "boolean") return field.default ? "true" : "false";
  if (typeof field.default === "number") return String(field.default);
  if (typeof field.default === "string") return field.default;
  return field.default.join(", ");
}

/** Seed the config form from the binding's persisted jsonb (preferred)
 *  with schema defaults as fallback. Hidden fields are skipped — they
 *  are auto-backfilled by handshake / scan flows and the operator has
 *  no input for them. Used by both `openEdit` (initial state) and the
 *  `initialConfigSeed` memo (drift baseline). */
function seedConfigFromBinding(
  descriptor: AdapterDescriptor,
  persisted: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const schema = descriptor.bindingConfigSchema;
  if (schema === undefined) return out;
  const persistedConfig = persisted ?? {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.hidden === true) continue;
    const persistedValue = persistedConfig[key];
    if (persistedValue !== undefined) {
      out[key] = coercePersistedToRaw(field, persistedValue);
      continue;
    }
    const def = defaultAsRaw(field);
    if (def !== undefined) out[key] = def;
  }
  return out;
}

/** Render the credential rotation form. Polling adapters → flat
 *  fields; webhook adapters → two grouped sections (auth +
 *  webhook_secret). All inputs render empty — we never read the
 *  existing plaintext (rotation is atomic; partial updates aren't
 *  supported in v0.1). */
interface RenderCredentialFieldsArgs {
  readonly descriptor: AdapterDescriptor;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly onChange: (key: string, value: string) => void;
}

function renderCredentialFields(
  args: RenderCredentialFieldsArgs,
): JSX.Element {
  const { descriptor, values, errors, onChange } = args;

  /** Render one `EditField` per property of a polling-shaped sub-schema.
   *  `prefix` is "" for polling adapters (flat keys) and `"auth."` /
   *  `"webhook_secret."` for the two webhook halves. */
  const renderGroup = (
    schema: PollingCredentialSchema,
    prefix: "" | "auth." | "webhook_secret.",
  ): JSX.Element[] =>
    Object.entries(schema.properties).map(([key, prop]) => {
      const fullKey = `${prefix}${key}`;
      return (
        <EditField
          key={fullKey}
          testId={`edit-cred-${fullKey}`}
          label={fullKey}
          {...(prop.description !== undefined
            ? { description: prop.description }
            : {})}
          value={values[fullKey] ?? ""}
          onChange={(v): void => onChange(fullKey, v)}
          {...(errors[fullKey] !== undefined
            ? { error: errors[fullKey] as string }
            : {})}
          secret={prop.secret === true}
        />
      );
    });

  if (descriptor.mode === "polling") {
    const schema = descriptor.credentialSchema as PollingCredentialSchema;
    return <>{renderGroup(schema, "")}</>;
  }
  const webhook = descriptor.credentialSchema as WebhookCredentialSchema;
  return (
    <>
      {renderGroup(webhook.properties.auth, "auth.")}
      {renderGroup(webhook.properties.webhook_secret, "webhook_secret.")}
    </>
  );
}

// ─── PR-W1 (phase-a appendix #14): AllowedPathsPanel ───────────────────────

interface AllowedPathsPanelProps {
  readonly binding: SourceBinding;
  readonly onChanged: () => void;
  /** Optional fetch test seam. Carries `undefined` when callers
   *  omit the prop (exactOptionalPropertyTypes). */
  readonly fetchImpl?: typeof fetch | undefined;
}

const ALLOWED_CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-1) var(--space-3)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-s)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.02em",
  background: "var(--paper)",
  color: "var(--ink-1)",
};

const ALLOWED_CHIP_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2)",
};

const ALLOWED_PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const ALLOWED_REMOVE_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--ink-3)",
  cursor: "pointer",
  fontSize: "var(--fs-micro)",
  padding: 0,
  margin: 0,
  fontFamily: "var(--font-mono)",
};

/** Sources row drill-down panel — renders the binding's
 *  `allowed_paths` as a chip list with an Edit affordance. The Edit
 *  mode flips the chips to mutable + adds a custom-input row; Save
 *  dispatches `PATCH /api/admin/source-bindings/:id` with
 *  `{allowed_paths}`. Cancel restores the binding's persisted list. */
function AllowedPathsPanel(props: AllowedPathsPanelProps): JSX.Element | null {
  const { t } = useTranslation();
  const persisted = useMemo<readonly string[]>(
    () => props.binding.allowedPaths ?? [],
    [props.binding.allowedPaths],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<readonly string[]>(persisted);
  const [customInput, setCustomInput] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hide the panel entirely when the backend doesn't surface
  // `allowedPaths` (pre-W1 fixtures). Once the server is upgraded
  // every response carries the field, even if it's an empty array.
  if (props.binding.allowedPaths === undefined) {
    return null;
  }

  const openEdit = (): void => {
    setEditing(true);
    setDraft(persisted);
    setError(null);
  };
  const cancel = (): void => {
    setEditing(false);
    setDraft(persisted);
    setCustomInput("");
    setError(null);
  };
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    setDraft((cur) => (cur.includes(trimmed) ? cur : [...cur, trimmed]));
    setCustomInput("");
    setError(null);
  };
  const remove = (pattern: string): void => {
    setDraft((cur) => cur.filter((v) => v !== pattern));
  };
  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      add(customInput);
    }
  };
  const save = async (): Promise<void> => {
    // Client-side gate mirroring `assertBindingNotWildcardOnly`.
    if (draft.length === 0) {
      setError(t("sources.allowedPaths.empty"));
      return;
    }
    for (const pattern of draft) {
      if (pattern === "**" || pattern.startsWith("**/")) {
        setError(t("sources.allowedPaths.invalidPattern"));
        return;
      }
    }
    setSubmitting(true);
    try {
      await fetchAdmin<{ id: string; allowed_paths: readonly string[] }>(
        `/api/admin/source-bindings/${props.binding.id}`,
        {
          method: "PATCH",
          body: { allowed_paths: draft },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      setEditing(false);
      setCustomInput("");
      props.onChanged();
    } catch (err) {
      // Map structured errors → i18n; default to "save failed".
      if (err instanceof ApiAuthError) {
        setError(t("sources.detail.errors.auth"));
      } else if (err instanceof ApiTransientError) {
        setError(t("sources.detail.errors.transient"));
      } else {
        setError(t("sourceBindingDetail.allowedPaths.saveFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={ALLOWED_PANEL_STYLE} data-testid="allowed-paths-panel">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        <span style={LABEL_STYLE}>
          {t("sourceBindingDetail.allowedPaths.title")}
        </span>
        {!editing ? (
          <Btn variant="subtle" onClick={openEdit}>
            {t("sourceBindingDetail.allowedPaths.editOpen")}
          </Btn>
        ) : null}
      </div>
      <div style={ALLOWED_CHIP_ROW_STYLE} data-testid="allowed-paths-list">
        {(editing ? draft : persisted).length === 0 ? (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
              color: "var(--ink-3)",
            }}
          >
            {t("sources.allowedPaths.empty")}
          </span>
        ) : (
          (editing ? draft : persisted).map((path) => (
            <span
              key={path}
              style={ALLOWED_CHIP_STYLE}
              data-testid={`allowed-paths-chip-${path}`}
            >
              <code>{path}</code>
              {editing ? (
                <button
                  type="button"
                  aria-label={`remove ${path}`}
                  onClick={(): void => remove(path)}
                  style={ALLOWED_REMOVE_BTN_STYLE}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>
      {editing ? (
        <>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <input
              name="allowed_paths_edit_input"
              data-testid="allowed-paths-edit-input"
              value={customInput}
              onChange={(e): void => setCustomInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={t("sources.allowedPaths.placeholder")}
              style={{
                flex: "1 1 auto",
                background: "var(--paper)",
                border: "1px solid var(--rule)",
                borderRadius: "var(--radius-m)",
                padding: "var(--space-2) var(--space-3)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-mono)",
                color: "var(--ink-1)",
              }}
            />
            <Btn variant="ghost" onClick={(): void => add(customInput)}>
              {t("sources.allowedPaths.addCustom")}
            </Btn>
          </div>
          {error !== null ? (
            <p
              role="alert"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--fs-small)",
                color: "var(--alert)",
                margin: 0,
              }}
            >
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <Btn variant="ghost" onClick={cancel} disabled={submitting}>
              {t("sourceBindingDetail.edit.cancel")}
            </Btn>
            <Btn
              variant="primary"
              onClick={(): void => {
                void save();
              }}
              disabled={submitting}
            >
              {submitting
                ? t("sourceBindingDetail.edit.saving")
                : t("sourceBindingDetail.edit.save")}
            </Btn>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─── PR-W4 (phase-a appendix #14) — Intake state panel ────────────────────

/** Defaulted zeros so a back-compat fixture without `intakeCounts`
 *  still paints the four tiles (showing "no intake yet" rather than
 *  blanks). The 4 status literals must stay in lock-step with the
 *  admin-API GET handler's `INTAKE_STATUS_KEYS` constant. */
const ZERO_INTAKE_COUNTS = {
  pending: 0,
  classified: 0,
  skipped: 0,
  failed: 0,
} as const;

interface IntakeStatePanelProps {
  readonly binding: SourceBinding;
}

/** "Intake state" panel — renders the four per-status counts from the
 *  GET response plus up to 3 most-recent failed-intake rows. Each
 *  failed row carries a Retry button parked in disabled state until
 *  PR-W2 ships the per-job retry endpoint; the tooltip names the PR
 *  so the operator can correlate the affordance with the roadmap. */
function IntakeStatePanel(props: IntakeStatePanelProps): JSX.Element {
  const { t } = useTranslation();
  const counts = props.binding.intakeCounts ?? ZERO_INTAKE_COUNTS;
  const recent = props.binding.recentFailedIntake ?? [];
  return (
    <div style={INTAKE_PANEL_STYLE} data-testid="intake-state-panel">
      <span style={LABEL_STYLE}>
        {t("sources.detail.intakeState.title")}
      </span>
      <div style={INTAKE_COUNTS_GRID_STYLE}>
        <IntakeCountTile
          label={t("sources.detail.intakeState.pending")}
          value={counts.pending}
        />
        <IntakeCountTile
          label={t("sources.detail.intakeState.classified")}
          value={counts.classified}
        />
        <IntakeCountTile
          label={t("sources.detail.intakeState.skipped")}
          value={counts.skipped}
        />
        <IntakeCountTile
          label={t("sources.detail.intakeState.failed")}
          value={counts.failed}
          tone="alert"
        />
      </div>
      {recent.length > 0 ? (
        <ul
          style={INTAKE_FAILED_LIST_STYLE}
          data-testid="intake-failed-list"
        >
          {recent.map((row) => (
            <IntakeFailedRow key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface IntakeCountTileProps {
  readonly label: string;
  readonly value: number;
  readonly tone?: "alert";
}

function IntakeCountTile(props: IntakeCountTileProps): JSX.Element {
  // `--alert` only when the operator actually has failures — a zero
  // failed-count paints neutral so a healthy binding doesn't surface
  // a red tile (design-system: alert is destructive-only).
  const valueStyle =
    props.tone === "alert" && props.value > 0
      ? INTAKE_COUNT_TILE_VALUE_FAILED_STYLE
      : INTAKE_COUNT_TILE_VALUE_STYLE;
  return (
    <div style={INTAKE_COUNT_TILE_STYLE}>
      <span style={INTAKE_COUNT_TILE_LABEL_STYLE}>{props.label}</span>
      <span style={valueStyle}>{props.value}</span>
    </div>
  );
}

interface IntakeFailedRowProps {
  readonly row: {
    readonly id: string;
    readonly errorClass: string | null;
    readonly errorTextSnippet: string | null;
  };
}

function IntakeFailedRow(props: IntakeFailedRowProps): JSX.Element {
  const { t } = useTranslation();
  // Truncated 8-char prefix mirrors the Activity-feed DLQ row pattern
  // so the operator gets a stable affordance for "which intake row?"
  // across surfaces. The full UUID lives in the title for audit.
  const shortId = props.row.id.slice(0, 8);
  return (
    <li
      style={INTAKE_FAILED_ROW_STYLE}
      data-testid={`intake-failed-row-${props.row.id}`}
    >
      <span style={INTAKE_FAILED_ROW_ID_STYLE} title={props.row.id}>
        {shortId}
      </span>
      {props.row.errorClass !== null ? (
        <span style={INTAKE_FAILED_ROW_CHIP_STYLE}>
          {props.row.errorClass}
        </span>
      ) : null}
      <p style={INTAKE_FAILED_ROW_SNIPPET_STYLE}>
        {props.row.errorTextSnippet ?? ""}
      </p>
      {/* Retry — disabled in W4, wires up in W2. The tooltip names
       *  PR-W2 so the operator knows why the affordance is parked
       *  without reading docs. `aria-disabled` mirrors the prop so
       *  screen readers announce the disabled state. */}
      <button
        type="button"
        disabled
        aria-disabled
        title={t("sources.detail.intakeState.retryDisabledTooltip")}
        style={INTAKE_RETRY_BTN_STYLE}
        data-testid={`intake-failed-row-retry-${props.row.id}`}
      >
        {t("sources.detail.intakeState.retry")}
      </button>
    </li>
  );
}

// ─── PR-W5-UI (phase-a appendix #15) — RetentionOverridePanel ──────────────

interface RetentionOverridePanelProps {
  readonly binding: SourceBinding;
  readonly onChanged: () => void;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Per-binding retention-days override editor (PR-W5 API branch
 *  `{retention_days_override}`). Operators clear by sending `null`
 *  (the W5 API treats `null` as "revert to domain default"). The
 *  Zod boundary caps at 1–365 days — out-of-range values surface
 *  a 422 with an inline error. The route also emits a 200 +
 *  `noOp: true` when the submitted value equals the persisted value;
 *  we surface a small "no changes saved" status row instead of
 *  bumping the parent's refresh nonce. */
function RetentionOverridePanel(
  props: RetentionOverridePanelProps,
): JSX.Element {
  const { t } = useTranslation();
  const persisted = props.binding.retentionDaysOverride ?? null;
  const domainDefault = props.binding.domainRetentionDays ?? null;
  const [draft, setDraft] = useState<string>(
    persisted === null ? "" : String(persisted),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<"saved" | "noOp" | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    setStatusNote(null);
    // Empty input → clear (null). Otherwise coerce to integer and
    // gate at the client side BEFORE PATCH; the W5 API's Zod schema
    // is the ground truth (1..365) and surfaces a 422 on out-of-range,
    // but a client-side bound gives the operator a faster error path.
    const trimmed = draft.trim();
    let body: { retention_days_override: number | null };
    if (trimmed === "") {
      body = { retention_days_override: null };
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        setError(t("sourceBindingDetail.retentionOverride.outOfRange"));
        return;
      }
      body = { retention_days_override: n };
    }
    setSubmitting(true);
    try {
      const resp = await fetchAdmin<{
        id: string;
        retention_days_override?: number | null;
        noOp?: boolean;
      }>(`/api/admin/source-bindings/${props.binding.id}`, {
        method: "PATCH",
        body,
        ...fetchOptsFor(props.fetchImpl),
      });
      if (resp.noOp === true) {
        setStatusNote("noOp");
      } else {
        setStatusNote("saved");
        props.onChanged();
      }
    } catch (err) {
      if (err instanceof ApiValidationError && err.status === 422) {
        setError(t("sourceBindingDetail.retentionOverride.outOfRange"));
        return;
      }
      if (err instanceof ApiAuthError) {
        setError(t("sources.detail.errors.auth"));
      } else if (err instanceof ApiTransientError) {
        setError(t("sources.detail.errors.transient"));
      } else {
        setError(t("sourceBindingDetail.retentionOverride.saveFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={ALLOWED_PANEL_STYLE} data-testid="retention-override-panel">
      <span id="retention-override-title" style={LABEL_STYLE}>
        {t("sourceBindingDetail.retentionOverride.title")}
      </span>
      <p style={EDIT_FIELD_DESCRIPTION_STYLE}>
        {domainDefault === null
          ? t("sourceBindingDetail.retentionOverride.helperNoDomainDefault")
          : t("sourceBindingDetail.retentionOverride.helper", {
              days: domainDefault,
            })}
      </p>
      <div
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}
      >
        <input
          id="retention-override-input"
          type="number"
          min={1}
          max={365}
          step={1}
          name="retention_days_override"
          aria-labelledby="retention-override-title"
          data-testid="retention-override-input"
          value={draft}
          onChange={(e): void => {
            setDraft(e.target.value);
            setError(null);
            setStatusNote(null);
          }}
          placeholder={
            domainDefault === null
              ? ""
              : t("sourceBindingDetail.retentionOverride.placeholder", {
                  days: domainDefault,
                })
          }
          style={{
            flex: "0 0 auto",
            width: "10ch",
            background: "var(--paper)",
            border:
              error !== null
                ? "1px solid var(--alert)"
                : "1px solid var(--rule)",
            borderRadius: "var(--radius-m)",
            padding: "var(--space-2) var(--space-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-mono)",
            color: "var(--ink-1)",
          }}
        />
        <Btn
          variant="subtle"
          disabled={submitting}
          onClick={(): void => {
            void save();
          }}
        >
          {submitting
            ? t("sourceBindingDetail.edit.saving")
            : t("sourceBindingDetail.retentionOverride.save")}
        </Btn>
      </div>
      {error !== null ? (
        <p
          role="alert"
          data-testid="retention-override-error"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--fs-small)",
            color: "var(--alert)",
            margin: 0,
          }}
        >
          {error}
        </p>
      ) : null}
      {statusNote === "noOp" ? (
        <span
          style={COPY_FEEDBACK_STYLE}
          role="status"
          data-testid="retention-override-noop"
        >
          {t("sourceBindingDetail.retentionOverride.noOp")}
        </span>
      ) : null}
      {statusNote === "saved" ? (
        <span
          style={COPY_FEEDBACK_STYLE}
          role="status"
          data-testid="retention-override-saved"
        >
          <GlyphFilledDisc
            size={10}
            title="saved"
            style={{ color: "var(--healthy)" }}
          />
          {t("sourceBindingDetail.retentionOverride.saved")}
        </span>
      ) : null}
    </div>
  );
}

// ─── PR-W5-UI (phase-a appendix #15) — NotesPanel ──────────────────────────

interface NotesPanelProps {
  readonly binding: SourceBinding;
  readonly onChanged: () => void;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Operator-facing notes editor for the binding's display label.
 *  Caps at 4096 chars at the client side (matches the W5 API Zod
 *  schema). The API rejects empty strings (`.min(1).max(4096)`) —
 *  operators clear via the dedicated "Clear notes" button which
 *  sends `null`. The notes value never enters audit metadata per
 *  §3.13; the API only records `notes_changed: true` + `cleared`. */
const NOTES_MAX_LENGTH = 4096;

function NotesPanel(props: NotesPanelProps): JSX.Element {
  const { t } = useTranslation();
  const persisted = props.binding.notes ?? "";
  const [draft, setDraft] = useState<string>(persisted);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const overCap = draft.length > NOTES_MAX_LENGTH;

  const patchNotes = async (value: string | null): Promise<void> => {
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await fetchAdmin<{ id: string; updated: true }>(
        `/api/admin/source-bindings/${props.binding.id}`,
        {
          method: "PATCH",
          body: { notes: value },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      setSaved(true);
      props.onChanged();
    } catch (err) {
      if (err instanceof ApiValidationError && err.status === 422) {
        setError(t("sourceBindingDetail.notes.overCap"));
        return;
      }
      if (err instanceof ApiAuthError) {
        setError(t("sources.detail.errors.auth"));
      } else if (err instanceof ApiTransientError) {
        setError(t("sources.detail.errors.transient"));
      } else {
        setError(t("sourceBindingDetail.notes.saveFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSave = (): void => {
    // overCap is also gated by the Save button's `disabled` prop; this
    // guard is kept as defense-in-depth so a programmatic click via the
    // DOM ref still surfaces an inline error rather than firing a PATCH
    // the server's Zod boundary would reject (Copilot review fix-up:
    // pin the surface so the dead-branch concern resolves to a
    // documented redundancy, not a latent UX gap).
    if (overCap) {
      setError(t("sourceBindingDetail.notes.overCap"));
      return;
    }
    // Empty string is rejected by the API — the operator clears via
    // the "Clear notes" button which sends `null`. If the operator
    // tries to Save while the textarea is empty, surface the same
    // hint inline.
    if (draft.length === 0) {
      setError(t("sourceBindingDetail.notes.emptyHint"));
      return;
    }
    void patchNotes(draft);
  };
  const onClear = (): void => {
    setDraft("");
    void patchNotes(null);
  };

  return (
    <div style={ALLOWED_PANEL_STYLE} data-testid="notes-panel">
      <span id="notes-title" style={LABEL_STYLE}>
        {t("sourceBindingDetail.notes.title")}
      </span>
      <p style={EDIT_FIELD_DESCRIPTION_STYLE}>
        {t("sourceBindingDetail.notes.helper")}
      </p>
      {/* TODO(wave-15-W9): migrate to <TextArea/> once the shared
       *  primitive lands. The inline styles below mirror
       *  EDIT_FIELD_INPUT_STYLE shape adapted to a multi-line element. */}
      <textarea
        id="notes-textarea-el"
        name="notes"
        aria-labelledby="notes-title"
        data-testid="notes-textarea"
        value={draft}
        onChange={(e): void => {
          setDraft(e.target.value);
          setError(null);
          setSaved(false);
        }}
        rows={4}
        style={{
          width: "100%",
          minHeight: "5rem",
          resize: "vertical",
          background: "var(--paper)",
          border: overCap ? "1px solid var(--alert)" : "1px solid var(--rule)",
          borderRadius: "var(--radius-m)",
          padding: "var(--space-2) var(--space-3)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--fs-body)",
          color: "var(--ink-1)",
        }}
      />
      <div
        style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}
      >
        <Btn
          variant="subtle"
          disabled={submitting || overCap}
          onClick={onSave}
        >
          {submitting
            ? t("sourceBindingDetail.edit.saving")
            : t("sourceBindingDetail.notes.save")}
        </Btn>
        <Btn
          variant="ghost"
          disabled={submitting || persisted.length === 0}
          onClick={onClear}
        >
          {t("sourceBindingDetail.notes.clear")}
        </Btn>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: overCap ? "var(--alert)" : "var(--ink-3)",
            marginLeft: "auto",
          }}
          data-testid="notes-char-count"
        >
          {draft.length} / {NOTES_MAX_LENGTH}
        </span>
      </div>
      {error !== null ? (
        <p
          role="alert"
          data-testid="notes-error"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--fs-small)",
            color: "var(--alert)",
            margin: 0,
          }}
        >
          {error}
        </p>
      ) : null}
      {saved ? (
        <span
          style={COPY_FEEDBACK_STYLE}
          role="status"
          data-testid="notes-saved"
        >
          <GlyphFilledDisc
            size={10}
            title="saved"
            style={{ color: "var(--healthy)" }}
          />
          {t("sourceBindingDetail.notes.saved")}
        </span>
      ) : null}
    </div>
  );
}
