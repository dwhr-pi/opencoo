/**
 * TextField — thin controlled-string shorthand over `Field`.
 *
 * The underlying `Field` exposes a discriminated union with two
 * mutually-exclusive modes (controlled with `value`+`onChange`,
 * uncontrolled with `inputRef`+`defaultValue`). `TextField` is the
 * common case: a controlled string input. Callers pass `value` +
 * `onChange` (as `(next: string) => void`) plus the usual label /
 * placeholder / helper trim.
 *
 * Wave-15 PR-W9 — the value of this primitive is the typed wrapper
 * around `onChange` (giving callers a `(string) => void` instead
 * of a raw React event), so call sites stay free of
 * `e.target.value` boilerplate. Uncontrolled-mode call sites still
 * use `Field` directly — that path's password-manager / 1Password
 * rationale lives in `Field.tsx`'s file header.
 */
import type { ChangeEvent, ReactNode } from "react";

import { Field } from "./Field.js";

export interface TextFieldProps {
  readonly label: ReactNode;
  readonly name: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly type?: "text" | "password" | "email";
  readonly required?: boolean;
  readonly helper?: ReactNode;
  readonly error?: string;
  readonly mono?: boolean;
  readonly secret?: boolean;
  readonly maxLength?: number;
}

export function TextField(props: TextFieldProps): JSX.Element {
  // The wrapper exists so callers don't have to deconstruct the
  // ChangeEvent at every site — the discriminated union upstream
  // still requires a real React event handler.
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const next =
      props.maxLength !== undefined && event.target.value.length > props.maxLength
        ? event.target.value.slice(0, props.maxLength)
        : event.target.value;
    props.onChange(next);
  };

  return (
    <Field
      label={props.label}
      name={props.name}
      value={props.value}
      onChange={onChange}
      {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
      {...(props.type !== undefined ? { type: props.type } : {})}
      {...(props.required !== undefined ? { required: props.required } : {})}
      {...(props.helper !== undefined ? { helper: props.helper } : {})}
      {...(props.error !== undefined ? { error: props.error } : {})}
      {...(props.mono !== undefined ? { mono: props.mono } : {})}
      {...(props.secret !== undefined ? { secret: props.secret } : {})}
    />
  );
}
