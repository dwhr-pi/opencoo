/**
 * Form field — label + input wrapper. References design-system
 * vars exclusively (font scale, radii, border colors).
 *
 * Supports two mutually-exclusive input modes, enforced at the
 * type level via a discriminated union (see `FieldProps`):
 *   - Controlled: pass `value` + `onChange`. React owns the input
 *     value across renders. Passing only one half is a TYPE
 *     ERROR — there is no silent "half-controlled" mode.
 *   - Uncontrolled: pass `inputRef` (+ optional `defaultValue`)
 *     instead of `value`/`onChange`. The DOM owns the value;
 *     the caller reads it on submit via `inputRef.current.value`.
 *     This is the mode used by forms that need to survive
 *     external value-setters (password-manager autofill,
 *     1Password / Bitwarden, etc) — controlled inputs fight
 *     reconciliation when an external script JS-sets the value
 *     via the native value setter, and React swaps the field
 *     state on the next render (PR-Z9 / G12).
 */
import type { ChangeEventHandler, Ref, ReactNode } from "react";

/** Props shared between controlled and uncontrolled modes. */
interface FieldPropsBase {
  readonly label: ReactNode;
  readonly name: string;
  readonly placeholder?: string;
  readonly type?: "text" | "password" | "email";
  readonly required?: boolean;
  readonly helper?: ReactNode;
  readonly error?: string;
  /** When true the input renders monospaced — useful for IDs +
   *  paths (CLAUDE.md "JetBrains Mono = paths, IDs, micro-labels"). */
  readonly mono?: boolean;
  readonly secret?: boolean;
  /** Live-validation status slot — A3 ships the prop + the
   *  `aria-busy` rendering when `'validating'`; B4 (live
   *  validation hook) populates it with the real value. The
   *  status drives an inline chip in B4; A3 only wires the SR
   *  surface (busy → SR announces "busy" while async validator is
   *  in flight). `'idle'|'valid'|'invalid'` are no-ops at the
   *  aria layer — B4 will color-key the chip from these. */
  readonly validationStatus?: "idle" | "validating" | "valid" | "invalid";
}

/**
 * Controlled mode: React owns the value. Caller MUST pass both
 * `value` AND `onChange` — passing only one half is a half-
 * controlled input where the unpaired prop is silently ignored.
 * The `inputRef`/`defaultValue` pair is forbidden in this mode.
 */
interface ControlledFieldProps extends FieldPropsBase {
  readonly value: string;
  readonly onChange: ChangeEventHandler<HTMLInputElement>;
  readonly inputRef?: never;
  readonly defaultValue?: never;
}

/**
 * Uncontrolled mode: the DOM owns the value. Caller MUST pass an
 * `inputRef` so it can read the live DOM value on submit. Pair
 * with optional `defaultValue` for an initial value. The
 * `value`/`onChange` pair is forbidden in this mode. See file
 * header for the password-manager rationale.
 */
interface UncontrolledFieldProps extends FieldPropsBase {
  readonly value?: never;
  readonly onChange?: never;
  /** Uncontrolled-mode escape hatch. The input is rendered without
   *  a React-owned `value`, and the caller reads the live DOM
   *  value via this ref. */
  readonly inputRef: Ref<HTMLInputElement>;
  readonly defaultValue?: string;
}

/**
 * Discriminated union: `value`+`onChange` (controlled) and
 * `inputRef`+`defaultValue` (uncontrolled) are paired — a caller
 * cannot accidentally pass only `value` without `onChange` (or
 * vice versa) and end up with an input that silently ignores the
 * provided prop.
 */
export type FieldProps = ControlledFieldProps | UncontrolledFieldProps;

export function Field(props: FieldProps): JSX.Element {
  const inputId = `field-${props.name}`;
  const helperId = `${inputId}-helper`;
  const errorId = `${inputId}-error`;
  // The discriminated union (see ControlledFieldProps /
  // UncontrolledFieldProps above) guarantees a caller cannot
  // half-pass — `value` and `onChange` are paired, as are
  // `inputRef` and `defaultValue`. We still branch on the
  // presence of `value` so React doesn't warn about an input
  // flipping between controlled and uncontrolled at runtime.
  const controlled = props.value !== undefined;
  // ARIA 1.2 chain. The helper text is always exposed via
  // `aria-describedby`. The error gets its dedicated
  // `aria-errormessage` slot, AND — when the helper is also
  // present — the error id joins the describedby chain so SR
  // clients that don't honor `aria-errormessage` still announce
  // it. Error-only fields use ONLY `aria-errormessage` (no
  // describedby) per ARIA 1.2.
  const describedByIds: string[] = [];
  if (props.helper !== undefined) {
    describedByIds.push(helperId);
    if (props.error !== undefined) describedByIds.push(errorId);
  }
  const describedBy = describedByIds.length > 0 ? describedByIds.join(" ") : undefined;
  return (
    <label
      htmlFor={inputId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--fs-small)",
        color: "var(--ink-2)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-micro)",
          color: "var(--ink-3)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {props.label}
        {props.required === true ? (
          <span style={{ color: "var(--alert)" }} aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </span>
      <input
        id={inputId}
        name={props.name}
        type={props.secret === true ? "password" : (props.type ?? "text")}
        {...(controlled
          ? { value: props.value, onChange: props.onChange }
          : props.defaultValue !== undefined
            ? { defaultValue: props.defaultValue }
            : {})}
        {...(props.inputRef !== undefined ? { ref: props.inputRef } : {})}
        placeholder={props.placeholder}
        required={props.required}
        autoComplete={props.secret === true ? "new-password" : "off"}
        aria-invalid={props.error !== undefined ? true : undefined}
        {...(describedBy !== undefined ? { "aria-describedby": describedBy } : {})}
        {...(props.error !== undefined ? { "aria-errormessage": errorId } : {})}
        {...(props.validationStatus === "validating" ? { "aria-busy": true } : {})}
        data-secret={props.secret === true ? "true" : undefined}
        style={{
          fontFamily: props.mono === true ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: "var(--fs-body)",
          padding: "8px 10px",
          background: "var(--paper)",
          border: "1px solid",
          borderColor: props.error !== undefined ? "var(--alert)" : "var(--rule)",
          borderRadius: "var(--radius-m)",
          color: "var(--ink)",
        }}
      />
      {props.helper !== undefined ? (
        <span
          id={helperId}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--ink-3)",
            letterSpacing: "0.04em",
          }}
        >
          {props.helper}
        </span>
      ) : null}
      {props.error !== undefined ? (
        <span
          id={errorId}
          role="alert"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--alert)",
            letterSpacing: "0.04em",
          }}
        >
          {props.error}
        </span>
      ) : null}
    </label>
  );
}
