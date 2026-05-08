/**
 * NewSourceBindingModal — `+ New binding` flow on the Sources
 * tab (phase-a appendix #2; PR-Q9 adds the third step).
 *
 * Three-step modal:
 *   1. Picker: adapter + target_domain + review_mode
 *      (review_mode prefilled from `defaultReviewModeFor`).
 *   2. Credentials: dynamic form rendered from the adapter's
 *      `credentialSchema`. Webhook adapters render BOTH
 *      `auth.*` AND `webhook_secret.*` fields.
 *   3. (PR-Q9) Operational settings: dynamic form rendered from
 *      the adapter's `bindingConfigSchema`. These are NOT
 *      credentials — fields render plain (no encrypted-note,
 *      no `type=password`). The submit body carries `config: { ... }`
 *      alongside `credentials: { ... }`.
 *
 * Pre-Q9 the wizard ended at step 2 and posted `config: {}`,
 * which made every Asana binding 500 at first webhook delivery
 * (the adapter's Zod schema requires `projectGid`).
 *
 * The "render config UI from a JSON Schema, not from
 * adapter-specific code" rule is in CLAUDE.md (Adapter
 * boundaries). The schemas for each adapter come from
 * `GET /api/admin/adapters` — same source the server validator
 * uses (no drift).
 *
 * Hard-nos honored:
 *   - primary CTA ink-on-paper (admin chrome).
 *   - secret credential fields rendered as type=password.
 *   - config-step inputs NEVER carry `data-secret`, regardless
 *     of any field-level `secret` flag (config is operational,
 *     not encrypted).
 *   - submit body never re-echoes an unknown adapter slug.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";
import { Modal } from "./Modal.js";
import { PickerSelect } from "./PickerSelect.js";
import { fetchAdmin } from "../lib/api.js";

const REVIEW_MODES = ["auto", "approve", "review"] as const;
const TRANSCRIPTION_ADAPTER_SLUGS = ["fireflies"] as const;
type ReviewMode = (typeof REVIEW_MODES)[number];
type DomainClass = "knowledge" | "catalog-workflows" | "catalog-skills";

/** Pure helper duplicated from `@opencoo/shared/source-adapter`'s
 *  `defaultReviewModeFor` so the UI doesn't need a node-only
 *  shared import for one branch. The shared module remains the
 *  authoritative server-side source. */
function defaultReviewModeFor(args: {
  readonly adapterSlug: string;
  readonly domainClass: DomainClass;
}): ReviewMode {
  if ((TRANSCRIPTION_ADAPTER_SLUGS as readonly string[]).includes(args.adapterSlug)) {
    return "approve";
  }
  if (args.domainClass === "catalog-skills") return "approve";
  return "auto";
}

interface CredentialFieldDescriptor {
  readonly type: "string";
  readonly description?: string;
  readonly secret?: boolean;
}

interface PollingSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CredentialFieldDescriptor>>;
  readonly required: readonly string[];
}

interface WebhookSchema {
  readonly type: "object";
  readonly properties: {
    readonly auth: PollingSchema;
    readonly webhook_secret: PollingSchema;
  };
  readonly required: readonly ("auth" | "webhook_secret")[];
}

type AnyCredentialSchema = PollingSchema | WebhookSchema;

/** PR-Q9: a single binding-config field. Mirrors the
 *  `BindingConfigField` shape from `@opencoo/shared/source-adapter`
 *  but redeclared locally so the UI module stays standalone (the
 *  shared module is a node-only build target). */
interface BindingConfigField {
  readonly type: "string" | "number" | "boolean" | "array";
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly default?: string | number | boolean | readonly string[];
  readonly items?: { readonly type: "string" };
  readonly minLength?: number;
  /** When true, the wizard does NOT render an input. Used for
   *  fields the adapter back-fills automatically. */
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
  /** PR-Q9: optional on the wire so older fixtures and tests
   *  stay compatible. The wizard treats absence as "no config
   *  step" — the wizard still ADVANCES to the config step (so the
   *  Create button stays in the same place), but renders no inputs
   *  and the operator just clicks Create. */
  readonly bindingConfigSchema?: BindingConfigSchema;
}

interface DomainRow {
  readonly id: string;
  readonly slug: string;
  readonly class: DomainClass;
}

export interface NewSourceBindingModalProps {
  readonly onCreated: (created: { id: string }) => void;
  readonly onClose: () => void;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

const FIELDS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const SECTION_HEADER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};

export function NewSourceBindingModal(
  props: NewSourceBindingModalProps,
): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<"picker" | "credentials" | "config">(
    "picker",
  );
  const [adapters, setAdapters] = useState<readonly AdapterDescriptor[]>([]);
  const [domains, setDomains] = useState<readonly DomainRow[]>([]);
  const [adapterSlug, setAdapterSlug] = useState<string>("");
  const [targetDomainSlug, setTargetDomainSlug] = useState<string>("");
  const [reviewMode, setReviewMode] = useState<ReviewMode>("auto");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>(
    {},
  );
  /** PR-Q9: operational-settings values keyed by field name.
   *  Stored as strings the same way credentials are; coerced to
   *  the schema-declared shape (boolean / array / number) in the
   *  submit step. */
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const fetchOpts =
    props.fetchImpl !== undefined
      ? { fetchImpl: props.fetchImpl as typeof fetch }
      : {};

  // Initial hydration — adapters + domains.
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const adaptersResp = await fetchAdmin<{
          adapters: readonly AdapterDescriptor[];
        }>("/api/admin/adapters", fetchOpts);
        const domainsResp = await fetchAdmin<{
          rows: ReadonlyArray<{
            id: string;
            slug: string;
            class: string;
          }>;
        }>("/api/admin/domains", fetchOpts);
        setAdapters(adaptersResp.adapters);
        const dRows: DomainRow[] = domainsResp.rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          class: r.class as DomainClass,
        }));
        setDomains(dRows);
        const firstAdapter = [...adaptersResp.adapters]
          .sort((a, b) => a.slug.localeCompare(b.slug))[0];
        const firstDomain = dRows[0];
        if (firstAdapter !== undefined) setAdapterSlug(firstAdapter.slug);
        if (firstDomain !== undefined) setTargetDomainSlug(firstDomain.slug);
      } catch (err) {
        setErrors({
          form:
            err instanceof Error
              ? err.message
              : t("sources.create.errors.generic"),
        });
      }
    })();
    // Mount-only fetch — fetchOpts is stable for the lifetime of this modal.
  }, []);

  // Recompute review_mode prefill whenever the
  // (adapter, domain) pair changes, BEFORE the operator opens
  // the credentials step. Operator can override.
  useEffect(() => {
    const domain = domains.find((d) => d.slug === targetDomainSlug);
    if (domain === undefined) return;
    const def = defaultReviewModeFor({
      adapterSlug,
      domainClass: domain.class,
    });
    setReviewMode(def);
  }, [adapterSlug, targetDomainSlug, domains]);

  const currentAdapter: AdapterDescriptor | undefined = useMemo(
    () => adapters.find((a) => a.slug === adapterSlug),
    [adapters, adapterSlug],
  );

  const validateCredentials = (): boolean => {
    if (currentAdapter === undefined) return false;
    const next: Record<string, string> = {};
    if (currentAdapter.mode === "polling") {
      const polling = currentAdapter.credentialSchema as PollingSchema;
      for (const req of polling.required) {
        if ((credentialValues[req] ?? "").length === 0) {
          next[req] = t("sources.create.errors.requiredField");
        }
      }
    } else {
      const webhook = currentAdapter.credentialSchema as WebhookSchema;
      for (const req of webhook.properties.auth.required) {
        if ((credentialValues[`auth.${req}`] ?? "").length === 0) {
          next[`auth.${req}`] = t("sources.create.errors.requiredField");
        }
      }
      for (const req of webhook.properties.webhook_secret.required) {
        if ((credentialValues[`webhook_secret.${req}`] ?? "").length === 0) {
          next[`webhook_secret.${req}`] = t(
            "sources.create.errors.requiredField",
          );
        }
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** PR-Q9: required-field gate for the operational-settings step.
   *  The server reasserts via `bindingConfigSchema.required[]`;
   *  this client-side check just keeps the form responsive. */
  const validateConfig = (): boolean => {
    if (currentAdapter === undefined) return false;
    const schema = currentAdapter.bindingConfigSchema;
    if (schema === undefined) return true;
    const next: Record<string, string> = {};
    for (const req of schema.required) {
      const field = schema.properties[req];
      if (field === undefined) continue;
      // Hidden fields are never user-supplied — skip the gate.
      if (field.hidden === true) continue;
      // PR-Q9 round-2: an unedited input still satisfies the
      // required-gate when the schema declares a default
      // (`buildConfigBody` falls back to the same default). Without
      // this fallback the wizard would block submit on a field the
      // server would have accepted.
      const editedRaw = configValues[req];
      const v =
        editedRaw !== undefined && editedRaw.length > 0
          ? editedRaw
          : (defaultAsRaw(field) ?? "");
      if (v.length === 0) {
        next[req] = t("sources.create.errors.requiredField");
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** PR-Q9: coerce string-keyed config values into the
   *  schema-declared shape before posting. Empty strings collapse
   *  to "field omitted" so optional fields don't pollute the
   *  jsonb with `""` placeholders. */
  const buildConfigBody = (
    schema: BindingConfigSchema | undefined,
  ): Record<string, unknown> => {
    if (schema === undefined) return {};
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      if (field.hidden === true) continue;
      // PR-Q9 round-2 (Copilot triage): when the operator hasn't
      // touched the input, fall back to the schema-declared
      // default so the value the wizard PREVIEWED is also the
      // value the API receives. Otherwise a field with `default:
      // "auto"` would be displayed as "auto" in the input but
      // omitted from the submit body — the server's required-gate
      // would 422 if it were required, or the persisted row
      // would lose the default.
      const editedRaw = configValues[key];
      const raw =
        editedRaw !== undefined && editedRaw.length > 0
          ? editedRaw
          : defaultAsRaw(field);
      if (raw === undefined || raw.length === 0) continue;
      if (field.type === "boolean") {
        out[key] = raw === "true";
      } else if (field.type === "number") {
        const n = Number(raw);
        if (Number.isFinite(n)) out[key] = n;
      } else if (field.type === "array") {
        // CSV → array-of-string; trim and drop empties.
        const items = raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length > 0) out[key] = items;
      } else {
        // string (with or without enum).
        out[key] = raw;
      }
    }
    return out;
  };

  const submit = async (): Promise<void> => {
    if (currentAdapter === undefined) return;
    if (!validateConfig()) return;
    setSubmitting(true);
    try {
      let credentials: Record<string, unknown>;
      if (currentAdapter.mode === "polling") {
        credentials = {};
        for (const k of Object.keys(currentAdapter.credentialSchema.properties)) {
          credentials[k] = credentialValues[k] ?? "";
        }
      } else {
        const webhook = currentAdapter.credentialSchema as WebhookSchema;
        const auth: Record<string, string> = {};
        for (const k of Object.keys(webhook.properties.auth.properties)) {
          auth[k] = credentialValues[`auth.${k}`] ?? "";
        }
        const webhookSecret: Record<string, string> = {};
        for (const k of Object.keys(webhook.properties.webhook_secret.properties)) {
          webhookSecret[k] = credentialValues[`webhook_secret.${k}`] ?? "";
        }
        credentials = { auth, webhook_secret: webhookSecret };
      }
      const config = buildConfigBody(currentAdapter.bindingConfigSchema);
      const result = await fetchAdmin<{ id: string }>(
        "/api/admin/source-bindings",
        {
          method: "POST",
          body: {
            adapter_slug: adapterSlug,
            target_domain_slug: targetDomainSlug,
            review_mode: reviewMode,
            credentials,
            config,
          },
          ...fetchOpts,
        },
      );
      props.onCreated(result);
    } catch (err) {
      setErrors({
        form:
          err instanceof Error
            ? err.message
            : t("sources.create.errors.generic"),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("sources.create.title")}
      subtitle={t("sources.create.subtitle")}
      onClose={props.onClose}
      maxWidth={620}
    >
      {step === "picker" ? (
        <div style={FIELDS_STYLE}>
          <PickerSelect
            name="adapter_slug"
            label={t("sources.create.fields.adapter")}
            value={adapterSlug}
            onChange={setAdapterSlug}
            options={adapters
              .map((a) => ({ value: a.slug, label: a.slug }))
              .sort((a, b) => a.label.localeCompare(b.label))}
          />
          <PickerSelect
            name="target_domain_slug"
            label={t("sources.create.fields.targetDomain")}
            value={targetDomainSlug}
            onChange={setTargetDomainSlug}
            options={domains.map((d) => ({ value: d.slug, label: d.slug }))}
          />
          <PickerSelect
            name="review_mode"
            label={t("sources.create.fields.reviewMode")}
            value={reviewMode}
            onChange={(v): void => setReviewMode(v as ReviewMode)}
            options={REVIEW_MODES.map((r) => ({ value: r, label: r }))}
          />
          {errors["form"] !== undefined ? (
            <p
              role="alert"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                color: "var(--alert)",
                margin: 0,
              }}
            >
              {errors["form"]}
            </p>
          ) : null}
          <div style={FOOTER_STYLE}>
            <Btn variant="ghost" onClick={props.onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn
              variant="primary"
              onClick={(): void => setStep("credentials")}
              disabled={
                adapterSlug.length === 0 || targetDomainSlug.length === 0
              }
            >
              {t("sources.create.next")}
            </Btn>
          </div>
        </div>
      ) : step === "credentials" ? (
        <CredentialsStep
          adapter={currentAdapter}
          values={credentialValues}
          errors={errors}
          onValueChange={(key, v): void => {
            setCredentialValues((cur) => ({ ...cur, [key]: v }));
            if (errors[key] !== undefined) {
              setErrors((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
            }
          }}
          onBack={(): void => setStep("picker")}
          onNext={(): void => {
            if (validateCredentials()) {
              setStep("config");
            }
          }}
        />
      ) : (
        <ConfigStep
          adapter={currentAdapter}
          values={configValues}
          errors={errors}
          submitting={submitting}
          onValueChange={(key, v): void => {
            setConfigValues((cur) => ({ ...cur, [key]: v }));
            if (errors[key] !== undefined) {
              setErrors((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
            }
          }}
          onBack={(): void => setStep("credentials")}
          onSubmit={(): void => {
            void submit();
          }}
        />
      )}
    </Modal>
  );
}

interface CredentialsStepProps {
  readonly adapter: AdapterDescriptor | undefined;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly onValueChange: (key: string, value: string) => void;
  readonly onBack: () => void;
  /** PR-Q9: credentials step now advances to the config step
   *  rather than submitting. The third step calls submit(). */
  readonly onNext: () => void;
}

function CredentialsStep(props: CredentialsStepProps): JSX.Element {
  const { t } = useTranslation();
  if (props.adapter === undefined) {
    return <div>{t("common.loading")}</div>;
  }
  const isWebhook = props.adapter.mode === "webhook";
  return (
    <div style={FIELDS_STYLE}>
      {isWebhook ? (
        <>
          <h3 style={SECTION_HEADER_STYLE}>{t("sources.create.section.auth")}</h3>
          <SchemaFields
            schema={
              (props.adapter.credentialSchema as WebhookSchema).properties.auth
            }
            pathPrefix="auth"
            values={props.values}
            errors={props.errors}
            onValueChange={props.onValueChange}
          />
          <h3 style={SECTION_HEADER_STYLE}>
            {t("sources.create.section.webhookSecret")}
          </h3>
          <SchemaFields
            schema={
              (props.adapter.credentialSchema as WebhookSchema).properties
                .webhook_secret
            }
            pathPrefix="webhook_secret"
            values={props.values}
            errors={props.errors}
            onValueChange={props.onValueChange}
          />
        </>
      ) : (
        <SchemaFields
          schema={props.adapter.credentialSchema as PollingSchema}
          pathPrefix=""
          values={props.values}
          errors={props.errors}
          onValueChange={props.onValueChange}
        />
      )}
      {props.errors["form"] !== undefined ? (
        <p
          role="alert"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--alert)",
            margin: 0,
          }}
        >
          {props.errors["form"]}
        </p>
      ) : null}
      <div style={FOOTER_STYLE}>
        <Btn variant="ghost" onClick={props.onBack}>
          {t("sources.create.back")}
        </Btn>
        <Btn variant="primary" onClick={props.onNext}>
          {t("sources.create.next")}
        </Btn>
      </div>
    </div>
  );
}

interface ConfigStepProps {
  readonly adapter: AdapterDescriptor | undefined;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly submitting: boolean;
  readonly onValueChange: (key: string, value: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}

/** PR-Q9: third wizard step — operational settings.
 *
 *  Renders the adapter's `bindingConfigSchema` as form inputs.
 *  Adapters without a `bindingConfigSchema` (older descriptors,
 *  test stubs) skip straight to submit. */
function ConfigStep(props: ConfigStepProps): JSX.Element {
  const { t } = useTranslation();
  if (props.adapter === undefined) {
    return <div>{t("common.loading")}</div>;
  }
  const schema = props.adapter.bindingConfigSchema;
  return (
    <div style={FIELDS_STYLE}>
      {schema !== undefined ? (
        <BindingConfigFields
          schema={schema}
          values={props.values}
          errors={props.errors}
          onValueChange={props.onValueChange}
        />
      ) : null}
      {props.errors["form"] !== undefined ? (
        <p
          role="alert"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--alert)",
            margin: 0,
          }}
        >
          {props.errors["form"]}
        </p>
      ) : null}
      <div style={FOOTER_STYLE}>
        <Btn variant="ghost" onClick={props.onBack}>
          {t("sources.create.back")}
        </Btn>
        <Btn
          variant="primary"
          disabled={props.submitting}
          onClick={props.onSubmit}
        >
          {props.submitting
            ? t("sources.create.submitting")
            : t("sources.create.submit")}
        </Btn>
      </div>
    </div>
  );
}

interface BindingConfigFieldsProps {
  readonly schema: BindingConfigSchema;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly onValueChange: (key: string, value: string) => void;
}

/** Render binding-config inputs. Hidden fields are omitted; enum
 *  fields render as <select>; arrays render as comma-separated
 *  text inputs (v0.1 only supports array-of-string config items).
 *  All inputs render WITHOUT `data-secret` regardless of any
 *  field-level marker — config is operational state, not a
 *  credential, and rendering with the encrypted-note glyph would
 *  mis-cue the operator. */
function BindingConfigFields(props: BindingConfigFieldsProps): JSX.Element {
  return (
    <>
      {Object.entries(props.schema.properties).map(([key, field]) => {
        if (field.hidden === true) return null;
        const required = props.schema.required.includes(key);
        const placeholder = arrayDefaultPlaceholder(field);
        const value = effectiveFieldValue(field, props.values[key]);
        if (field.enum !== undefined) {
          return (
            <div
              key={key}
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <PickerSelect
                name={key}
                label={key}
                value={value}
                onChange={(v): void => props.onValueChange(key, v)}
                options={field.enum.map((e) => ({ value: e, label: e }))}
              />
              {field.description !== undefined ? (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-micro)",
                    color: "var(--ink-3)",
                    letterSpacing: "0.04em",
                  }}
                >
                  {field.description}
                </span>
              ) : null}
            </div>
          );
        }
        return (
          <Field
            key={key}
            name={key}
            label={key}
            value={value}
            onChange={(e): void => props.onValueChange(key, e.target.value)}
            required={required}
            // Operational settings → never `secret`. The Field
            // component would otherwise render a password input
            // and the `● stored encrypted` note, which would
            // mislead the operator.
            secret={false}
            {...(placeholder !== undefined ? { placeholder } : {})}
            {...(field.description !== undefined
              ? { helper: field.description }
              : {})}
            {...(props.errors[key] !== undefined
              ? { error: props.errors[key] }
              : {})}
          />
        );
      })}
    </>
  );
}

/** Compute the value the input should render. Falls back to the
 *  schema-declared default the FIRST time a field renders, so
 *  the operator sees the prefill instead of an empty input. The
 *  operator's edits take precedence (state is set on change). */
function effectiveFieldValue(
  field: BindingConfigField,
  current: string | undefined,
): string {
  if (current !== undefined && current.length > 0) return current;
  if (field.default === undefined) return current ?? "";
  if (typeof field.default === "boolean") return field.default ? "true" : "false";
  if (typeof field.default === "number") return String(field.default);
  if (typeof field.default === "string") return field.default;
  // array default — render CSV.
  return field.default.join(", ");
}

/** Coerce a schema-declared default into the same string form
 *  `configValues` uses (booleans → "true"/"false"; numbers →
 *  String(n); arrays → CSV). PR-Q9 round-2 (Copilot triage). */
function defaultAsRaw(field: BindingConfigField): string | undefined {
  if (field.default === undefined) return undefined;
  if (typeof field.default === "boolean") return field.default ? "true" : "false";
  if (typeof field.default === "number") return String(field.default);
  if (typeof field.default === "string") return field.default;
  return field.default.join(", ");
}

/** Hint placeholder for array fields when no default is set. */
function arrayDefaultPlaceholder(
  field: BindingConfigField,
): string | undefined {
  if (field.type !== "array") return undefined;
  return "comma-separated values";
}

interface SchemaFieldsProps {
  readonly schema: PollingSchema;
  readonly pathPrefix: string;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly onValueChange: (key: string, value: string) => void;
}

function SchemaFields(props: SchemaFieldsProps): JSX.Element {
  const fields = Object.entries(props.schema.properties);
  return (
    <>
      {fields.map(([key, descriptor]) => {
        const fullKey =
          props.pathPrefix.length > 0 ? `${props.pathPrefix}.${key}` : key;
        const required = props.schema.required.includes(key);
        return (
          <Field
            key={fullKey}
            name={fullKey}
            label={fullKey}
            value={props.values[fullKey] ?? ""}
            onChange={(e): void => props.onValueChange(fullKey, e.target.value)}
            secret={descriptor.secret === true}
            required={required}
            {...(descriptor.description !== undefined
              ? { helper: descriptor.description }
              : {})}
            {...(props.errors[fullKey] !== undefined
              ? { error: props.errors[fullKey] }
              : {})}
          />
        );
      })}
    </>
  );
}
