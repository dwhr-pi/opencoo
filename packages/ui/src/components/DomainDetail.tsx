/**
 * DomainDetail — Domains row drill-down modal (PR-R1, phase-a
 * appendix #10).
 *
 * The Domains tab row click opens this modal. It exposes the three
 * lifecycle actions an operator needs to manage a typo'd or retired
 * domain entirely from the UI:
 *
 *   1. Edit `display_name`, `locale`, or `is_aggregator`. `slug`
 *      and `class` are NOT mutable here (rename = re-create; class
 *      is structural); the form does not even render fields for
 *      them.
 *   2. Disable (soft-delete) — sets `disabled_at` on the domain.
 *      Confirmation copy warns the operator that re-enable is NOT
 *      in v0.1 (one-way valve).
 *   3. Hard-delete — removes the row entirely. Refused with a
 *      helper message when bindings reference the domain. The
 *      destructive button gates behind a checkbox per the design-
 *      system rule for irreversible actions.
 *
 * Hard-nos honored (CLAUDE.md design system):
 *   - NO drop shadows for elevation (depth = border + bg shift)
 *   - NO advisory amber on destructive items — `--alert` only
 *   - NO emoji / NO marketing voice / NO spinners
 *   - lowercase `opencoo` in any future copy
 */
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import {
  ApiAuthError,
  ApiTransientError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import type { Domain } from "../types.js";

export interface DomainDetailProps {
  readonly domain: Domain;
  /** Closes the modal (Esc, backdrop, "Close" button) AND fires
   *  after a successful Save / Disable / Delete action. */
  readonly onClose: () => void;
  /** Bumps the parent listing's refresh nonce after a successful
   *  mutation so the table re-fetches and the row picks up the new
   *  state. */
  readonly onChanged: () => void;
  /** @internal Test seam — defaults to globalThis.fetch via fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
}

type Stage = "idle" | "disable" | "delete";

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

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

const HELPER_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-3)",
  margin: 0,
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--space-3)",
  marginTop: "var(--space-3)",
  flexWrap: "wrap",
};

const DESTRUCTIVE_GROUP_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
};

const FORM_FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const INPUT_STYLE: CSSProperties = {
  background: "var(--paper)",
  color: "var(--ink)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--fg-2)",
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

type LocaleOption = "en" | "pl" | "auto";

function isLocale(v: string): v is LocaleOption {
  return v === "en" || v === "pl" || v === "auto";
}

export function DomainDetail(props: DomainDetailProps): JSX.Element {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Form state mirrors current domain values; only fields that
  // changed are sent in the PATCH body.
  const [displayName, setDisplayName] = useState(props.domain.name);
  const [locale, setLocale] = useState<LocaleOption>(
    isLocale(props.domain.locale) ? props.domain.locale : "en",
  );
  const [isAggregator, setIsAggregator] = useState(props.domain.isAggregator);

  // Hard-delete confirmation gate — checkbox MUST be ticked before
  // the destructive button is enabled (design-system rule for
  // irreversible actions).
  const [hardDeleteAck, setHardDeleteAck] = useState(false);

  const bindingCount = props.domain.bindingCount ?? 0;

  /** Map a thrown error to an operator-facing i18n string.
   *  Mirrors the SourceBindingDetail pattern (Q10b) so neither
   *  raw `err.message` nor the diagnostic shape leak into the UI. */
  const mapActionError = (err: unknown, defaultKey: string): string => {
    if (err instanceof ApiAuthError) {
      return t("domains.detail.errors.auth");
    }
    if (err instanceof ApiTransientError) {
      return t("domains.detail.errors.transient");
    }
    return t(defaultKey);
  };

  const submitSave = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (displayName !== props.domain.name) body["display_name"] = displayName;
      if (locale !== props.domain.locale) body["locale"] = locale;
      if (isAggregator !== props.domain.isAggregator) {
        body["is_aggregator"] = isAggregator;
      }
      // No-op submit (operator clicked Save without editing) — bail
      // without a round-trip rather than producing a 422 from the
      // server.
      if (Object.keys(body).length === 0) {
        props.onClose();
        return;
      }
      await fetchAdmin<{ id: string }>(
        `/api/admin/domains/${props.domain.id}`,
        {
          method: "PATCH",
          body,
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onChanged();
      props.onClose();
    } catch (err) {
      // 409 aggregator_already_set has its own specific copy; the
      // operator needs to know which other domain currently holds
      // the flag.
      if (err instanceof ApiValidationError && err.status === 409) {
        const errBody = err.body as { error?: string } | undefined;
        if (errBody?.error === "aggregator_already_set") {
          setActionError(t("domains.detail.errors.aggregatorAlreadySet"));
          return;
        }
      }
      setActionError(mapActionError(err, "domains.detail.errors.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisable = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin(
        `/api/admin/domains/${props.domain.id}`,
        {
          method: "DELETE",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onChanged();
      props.onClose();
    } catch (err) {
      setActionError(
        mapActionError(err, "domains.detail.errors.disableFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submitHardDelete = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin(
        `/api/admin/domains/${props.domain.id}?hard=1`,
        {
          method: "DELETE",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onChanged();
      props.onClose();
    } catch (err) {
      // 409 fk_restricted means bindings reference the domain and
      // the operator must migrate them first. Surface the specific
      // copy so the operator knows where to go (Sources tab).
      if (err instanceof ApiValidationError && err.status === 409) {
        setActionError(t("domains.detail.errors.deleteFkRestricted"));
      } else {
        setActionError(
          mapActionError(err, "domains.detail.errors.deleteFailed"),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onIdle = (): void => {
    setStage("idle");
    setActionError(null);
    setHardDeleteAck(false);
  };

  if (stage === "disable") {
    return (
      <Modal
        title={t("domains.detail.actions.confirmDisableTitle")}
        onClose={props.onClose}
        maxWidth={520}
      >
        <div style={SECTION_STYLE}>
          <p style={CONFIRM_BODY_STYLE}>
            {t("domains.detail.actions.confirmDisableBody")}
          </p>
          {actionError !== null ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {actionError}
            </p>
          ) : null}
          <div style={CONFIRM_FOOTER_STYLE}>
            <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
              {t("domains.detail.actions.cancel")}
            </Btn>
            <button
              type="button"
              disabled={submitting}
              onClick={(): void => {
                void submitDisable();
              }}
              style={DESTRUCTIVE_CONFIRM_BTN_STYLE}
            >
              {t("domains.detail.actions.confirmDisable")}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (stage === "delete") {
    const canConfirm = hardDeleteAck && !submitting && bindingCount === 0;
    return (
      <Modal
        title={t("domains.detail.actions.confirmDeleteTitle")}
        onClose={props.onClose}
        maxWidth={560}
      >
        <div style={SECTION_STYLE}>
          <p style={CONFIRM_BODY_STYLE}>
            {t("domains.detail.actions.confirmDeleteBody")}
          </p>
          {bindingCount > 0 ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {t("domains.detail.actions.deleteBlocked", { n: bindingCount })}
            </p>
          ) : null}
          <label style={CHECKBOX_ROW_STYLE}>
            <input
              type="checkbox"
              checked={hardDeleteAck}
              disabled={submitting || bindingCount > 0}
              onChange={(e): void => setHardDeleteAck(e.target.checked)}
            />
            {t("domains.detail.actions.confirmDeleteCheckbox")}
          </label>
          {actionError !== null ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {actionError}
            </p>
          ) : null}
          <div style={CONFIRM_FOOTER_STYLE}>
            <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
              {t("domains.detail.actions.cancel")}
            </Btn>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={(): void => {
                void submitHardDelete();
              }}
              style={{
                ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                opacity: canConfirm ? 1 : 0.55,
                cursor: canConfirm ? "pointer" : "not-allowed",
              }}
            >
              {t("domains.detail.actions.confirmDelete")}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t("domains.detail.title")}
      subtitle={t("domains.detail.subtitle")}
      onClose={props.onClose}
      maxWidth={620}
    >
      <div style={SECTION_STYLE}>
        {/* Read-only identity block. */}
        <div style={FIELD_GRID_STYLE}>
          <span style={LABEL_STYLE}>{t("domains.detail.labels.slug")}</span>
          <span style={MONO_VALUE_STYLE}>{props.domain.slug}</span>

          <span style={LABEL_STYLE}>
            {t("domains.detail.labels.domainId")}
          </span>
          <span style={MONO_VALUE_STYLE}>{props.domain.id}</span>

          <span style={LABEL_STYLE}>{t("domains.detail.labels.class")}</span>
          <span style={VALUE_STYLE}>{props.domain.class}</span>

          <span style={LABEL_STYLE}>{t("domains.detail.labels.bindings")}</span>
          <span style={MONO_VALUE_STYLE}>{bindingCount}</span>
        </div>

        {/* Editable fields. */}
        <div style={FORM_FIELD_STYLE}>
          <label
            htmlFor="domain-detail-display-name"
            style={LABEL_STYLE}
          >
            {t("domains.detail.fields.displayName")}
          </label>
          <input
            id="domain-detail-display-name"
            type="text"
            value={displayName}
            disabled={submitting}
            onChange={(e): void => setDisplayName(e.target.value)}
            maxLength={120}
            style={INPUT_STYLE}
          />
        </div>

        <div style={FORM_FIELD_STYLE}>
          <label htmlFor="domain-detail-locale" style={LABEL_STYLE}>
            {t("domains.detail.fields.locale")}
          </label>
          <select
            id="domain-detail-locale"
            value={locale}
            disabled={submitting}
            onChange={(e): void => {
              const v = e.target.value;
              if (isLocale(v)) setLocale(v);
            }}
            style={INPUT_STYLE}
          >
            <option value="en">en</option>
            <option value="pl">pl</option>
            <option value="auto">auto</option>
          </select>
        </div>

        <label style={CHECKBOX_ROW_STYLE}>
          <input
            type="checkbox"
            checked={isAggregator}
            disabled={submitting}
            onChange={(e): void => setIsAggregator(e.target.checked)}
          />
          {t("domains.detail.fields.aggregator")}
        </label>

        {props.domain.disabledAt !== null &&
        props.domain.disabledAt !== undefined ? (
          <p style={HELPER_TEXT_STYLE}>
            {t("domains.detail.labels.disabledAt")}:{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              {props.domain.disabledAt}
            </code>
          </p>
        ) : null}

        {actionError !== null ? (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {actionError}
          </p>
        ) : null}

        <div style={ACTION_ROW_STYLE}>
          <Btn variant="ghost" onClick={props.onClose} disabled={submitting}>
            {t("domains.detail.actions.close")}
          </Btn>
          <div style={DESTRUCTIVE_GROUP_STYLE}>
            <Btn
              variant="subtle"
              onClick={(): void => setStage("disable")}
              disabled={submitting}
            >
              {t("domains.detail.actions.disable")}
            </Btn>
            <Btn
              variant="ghost"
              onClick={(): void => setStage("delete")}
              disabled={submitting}
            >
              {t("domains.detail.actions.delete")}
            </Btn>
            <Btn
              variant="primary"
              onClick={(): void => {
                void submitSave();
              }}
              disabled={submitting}
            >
              {submitting
                ? t("domains.detail.actions.saving")
                : t("domains.detail.actions.save")}
            </Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}
