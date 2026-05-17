/**
 * RevertOverrideModal — confirm prompt-override revert
 * (PR-W7a, phase-a appendix #15).
 *
 * Destructive-confirm pattern from `DomainDetail.tsx`'s
 * hard-delete flow: alert-red border + body, gate the confirm
 * button behind a checkbox so a stray click can't drop the
 * override silently. The action is one-way (the prior body is
 * gone after the DELETE — only the audit log records it), so
 * the gate matters more than for a soft action.
 */
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--fg-1)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 12,
};

const CONFIRM_BTN_STYLE: CSSProperties = {
  background: "var(--alert)",
  color: "var(--paper)",
  border: "1px solid var(--alert)",
  borderRadius: 3,
  padding: "8px 14px",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

export interface RevertOverrideModalProps {
  readonly promptName: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function RevertOverrideModal(
  props: RevertOverrideModalProps,
): JSX.Element {
  const { t } = useTranslation();
  const [acked, setAcked] = useState(false);
  return (
    <Modal
      title={t("prompts.editor.revertConfirmTitle")}
      onClose={props.onClose}
      maxWidth={520}
      actions={
        <div style={FOOTER_STYLE}>
          <Btn variant="ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </Btn>
          <button
            type="button"
            data-testid="revert-confirm-btn"
            disabled={!acked}
            onClick={(): void => props.onConfirm()}
            style={{
              ...CONFIRM_BTN_STYLE,
              opacity: acked ? 1 : 0.55,
              cursor: acked ? "pointer" : "not-allowed",
            }}
          >
            {t("prompts.editor.revertConfirm")}
          </button>
        </div>
      }
    >
      <div style={BODY_STYLE}>
        <p style={{ margin: 0, color: "var(--fg-1)" }}>
          {t("prompts.editor.revertConfirmBody", { name: props.promptName })}
        </p>
        <label style={CHECKBOX_ROW_STYLE}>
          <input
            type="checkbox"
            checked={acked}
            data-testid="revert-ack-checkbox"
            onChange={(e): void => setAcked(e.target.checked)}
          />
          {t("prompts.editor.revertAck")}
        </label>
      </div>
    </Modal>
  );
}
