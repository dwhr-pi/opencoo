/**
 * TextArea — multi-line companion to `TextField`.
 *
 * Shares Field's label + helper + error chrome so a form mixing
 * single-line and multi-line inputs renders consistently. The
 * `<textarea>` element under the hood means `rows` is the height
 * knob, not `type`.
 *
 * Wave-15 PR-W9 — the W5-UI notes editor (deferred) consumes
 * this primitive; ship it now so other multi-line surfaces have
 * a single component to reach for.
 */
import type { ChangeEvent, ReactNode } from "react";

export interface TextAreaProps {
  readonly label: ReactNode;
  readonly name: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly helper?: ReactNode;
  readonly error?: string;
  readonly mono?: boolean;
  readonly rows?: number;
  readonly maxLength?: number;
}

export function TextArea(props: TextAreaProps): JSX.Element {
  const inputId = `field-${props.name}`;
  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next =
      props.maxLength !== undefined && event.target.value.length > props.maxLength
        ? event.target.value.slice(0, props.maxLength)
        : event.target.value;
    props.onChange(next);
  };

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
      <textarea
        id={inputId}
        name={props.name}
        value={props.value}
        onChange={onChange}
        rows={props.rows ?? 4}
        placeholder={props.placeholder}
        required={props.required}
        aria-invalid={props.error !== undefined ? true : undefined}
        style={{
          fontFamily: props.mono === true ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: "var(--fs-body)",
          padding: "8px 10px",
          background: "var(--paper)",
          border: "1px solid",
          borderColor: props.error !== undefined ? "var(--alert)" : "var(--rule)",
          borderRadius: "var(--radius-m)",
          color: "var(--ink)",
          resize: "vertical",
          minHeight: 60,
        }}
      />
      {props.helper !== undefined ? (
        <span
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
