/**
 * PatEntryModal — first-load admin auth modal (PR 29 / plan
 * #131; UX token-binding spec; collapsed onto the shared `Modal`
 * shell in PR-A1 / phase-a appendix #16; PAT input collapsed
 * onto the shared `Field` primitive in PR-A3 / wave-16 so the
 * SR-only aria-described/errormessage chain is inherited by a
 * keyboard-only operator on a screen reader).
 *
 * Operator pastes a Gitea PAT into a single password-masked
 * field; PAT lives in sessionStorage and clears on tab close.
 * Admin-only chrome (no agent layer involved): primary button
 * is ink-on-paper, NOT advisory amber.
 *
 * Wave-16 (PR-A1) note: this modal is *gating* — operator cannot
 * dismiss it, and `onClose` is intentionally a no-op. We still
 * compose on the shared `<dialog>`-backed Modal so we inherit
 * focus-trap + top-layer + reduced-motion + Firefox
 * font-inherit fix for free. The Modal's backdrop-click + Esc
 * handlers route into the no-op `onClose` (auth or nothing).
 *
 * Wave-16 (PR-A3) note: the PAT input now goes through `Field`
 * with `secret` + `mono`. Field gives us the
 * `aria-describedby`/`aria-errormessage`/`aria-invalid` chain
 * and `role="alert"` on the error span for free; the
 * storage-note rides the `helper` slot, the auth error rides
 * the `error` slot. We lose the (cosmetic) focused-state
 * border, which the design system never spec'd anyway — the
 * border + paper-on-overlay is the elevation contract.
 *
 * Design-system bindings (every visual references a CSS var
 * from `colors_and_type.css`; no literals):
 *   - modal shell: inherited from `Modal.tsx` (paper / ink /
 *     radius-xl). Padding handled by the shell's regions.
 *   - input: inherited from `Field` (secret + mono → password
 *     input rendered in JetBrains Mono per
 *     `design_system/colors_and_type.css`).
 *   - primary-btn: bg var(--ink), fg var(--paper)
 *
 * Hard-nos honored:
 *   - NO advisory amber on the primary CTA (admin auth, not
 *     agent layer).
 *   - NO eye-icon "show password" toggle (PAT is sensitive).
 *   - NO close icon (modal is gating; auth or nothing).
 *   - NO spinner on submit — disable + label-swap to
 *     `authenticating…` in mono.
 *   - NO drop shadow (border + paper-on-overlay is the
 *     elevation).
 *   - NO emoji, NO Lucide icons, NO marketing voice.
 */
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Field } from "./Field.js";
import { Modal } from "./Modal.js";

const INSTRUCTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 400,
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

const PRIMARY_BTN_BASE_STYLE: CSSProperties = {
  background: "var(--ink)",
  color: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
  width: "100%",
};

export interface PatEntryModalProps {
  readonly onSubmit: (pat: string) => Promise<void> | void;
  readonly error?: string | null;
}

export function PatEntryModal(props: PatEntryModalProps): JSX.Element {
  const { t } = useTranslation();
  const [pat, setPat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    if (pat.length === 0) {
      setLocalError(t("auth.patEmpty"));
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await props.onSubmit(pat);
    } finally {
      setSubmitting(false);
    }
  };

  const error = localError ?? props.error ?? null;

  const btnStyle: CSSProperties = {
    ...PRIMARY_BTN_BASE_STYLE,
    ...(submitting
      ? {
          background: "var(--ink-3)",
          borderColor: "var(--ink-3)",
          cursor: "not-allowed",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-mono)",
          fontWeight: 600,
        }
      : {}),
  };

  return (
    <Modal
      title={t("auth.modalTitle")}
      // Gating modal — there's no Cancel / X. Esc and backdrop
      // both route here so the operator's only path out is
      // successful auth.
      onClose={(): void => undefined}
      maxWidth={420}
    >
      <p style={INSTRUCTION_STYLE}>{t("auth.patPrompt")}</p>
      <Field
        name="pat"
        label={t("auth.patFieldLabel")}
        value={pat}
        onChange={(e): void => setPat(e.target.value)}
        secret
        mono
        // Spec: secret-field placeholder must NEVER look like a
        // real value. Empty placeholder is the safe choice here.
        placeholder=""
        helper={t("auth.storageNote")}
        {...(error !== null ? { error } : {})}
      />
      <button
        type="button"
        disabled={submitting}
        onClick={(): void => {
          void submit();
        }}
        style={btnStyle}
      >
        {submitting ? t("auth.authenticating") : t("auth.patSubmit")}
      </button>
    </Modal>
  );
}
