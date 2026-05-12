/**
 * Asana OutputAdapter — write tasks (PR 24 / plan #115).
 *
 * Shape-conforming `OutputAdapter<AsanaTaskPayload>`. The
 * factory takes a `makeApi` injection so use-case tests inject
 * a mock; production wiring (PR 30) wraps the real Asana SDK.
 *
 * Error mapping (orchestrator override 8):
 *   - 429 + Retry-After → upstream-quota with retryAfterSeconds
 *   - 5xx / network drop → transient
 *   - 4xx (other) → validation
 *
 * Payload validation:
 *   - Zod `.strict()` parse BEFORE the API call. Over-keyed
 *     or malformed payloads throw OutputAdapterValidationError.
 */
import {
  OutputAdapterValidationError,
  classifyHttpError,
  type OutputAdapter,
  type OutputCredentialSchema,
  type OutputWriteArgs,
  type OutputWriteResult,
} from "@opencoo/shared/output-adapter";

import type {
  AsanaApiError,
  AsanaCreateTaskArgs,
  AsanaLikeApi,
} from "./asana-api.js";
import {
  asanaTaskPayloadSchema,
  type AsanaTaskPayload,
} from "./payload-schema.js";

export const ASANA_OUTPUT_ADAPTER_SLUG = "asana" as const;

/** JSON-Schema-shaped credential descriptor the Management UI
 *  renders. The Asana token field is `secret: true` so the UI
 *  masks input + persists via CredentialStore. */
export const asanaOutputCredentialSchema: OutputCredentialSchema = {
  type: "object",
  properties: {
    asanaPersonalAccessToken: {
      type: "string",
      description:
        "Asana Personal Access Token. Generate via Asana → My Profile Settings → Apps.",
      secret: true,
    },
  },
  required: ["asanaPersonalAccessToken"],
};

export type MakeAsanaApi = () => AsanaLikeApi;

export interface CreateAsanaOutputAdapterArgs {
  /** API factory — production wraps the real Asana SDK; tests
   *  inject the mock from `./testing/mock-asana-tasks.ts`. */
  readonly makeApi: MakeAsanaApi;
}

function isAsanaApiError(value: unknown): value is AsanaApiError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown };
  return v.kind === "http" || v.kind === "transient";
}

export function createAsanaOutputAdapter(
  args: CreateAsanaOutputAdapterArgs,
): OutputAdapter<AsanaTaskPayload> {
  return {
    slug: ASANA_OUTPUT_ADAPTER_SLUG,
    payloadSchema: asanaTaskPayloadSchema,
    credentialSchema: asanaOutputCredentialSchema,
    async write(
      writeArgs: OutputWriteArgs<AsanaTaskPayload>,
    ): Promise<OutputWriteResult> {
      // Assertion 8: payload-schema-rejects-extra-keys.
      // .strict() parse fails on extra keys; we wrap the Zod
      // error in OutputAdapterValidationError so the BullMQ
      // wrapper DLQs without retry.
      const parsed = asanaTaskPayloadSchema.safeParse(writeArgs.payload);
      if (!parsed.success) {
        throw new OutputAdapterValidationError(
          `asana output: payload failed schema validation (${parsed.error.issues.length} issue(s))`,
          { cause: parsed.error },
        );
      }
      const payload = parsed.data;

      // Resolve the access token from the CredentialStore.
      // Tests inject a mock store that returns a buffer; the
      // adapter doesn't care about the bytes.
      const record = await writeArgs.credentialStore.read(
        writeArgs.credentialId,
      );

      const api = args.makeApi();
      // PR-W2 (phase-a appendix #13) — branch on which body field
      // the per-agent transformer supplied. The Zod schema's `.refine()`
      // already enforced "exactly one of notes | htmlNotes"; we replay
      // the discriminator here verbatim so the underlying Asana API
      // receives exactly one of `notes` / `html_notes` per call.
      const callArgs: AsanaCreateTaskArgs = {
        accessToken: record.plaintext,
        projectGid: payload.projectGid,
        title: payload.title,
        ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
        ...(payload.htmlNotes !== undefined
          ? { htmlNotes: payload.htmlNotes }
          : {}),
        ...(payload.dueOn !== undefined ? { dueOn: payload.dueOn } : {}),
        ...(payload.assigneeGid !== undefined
          ? { assigneeGid: payload.assigneeGid }
          : {}),
      };

      try {
        const result = await api.createTask(callArgs);
        return {
          externalId: result.gid,
          ...(result.permalinkUrl !== undefined
            ? { externalUrl: result.permalinkUrl }
            : {}),
        };
      } catch (err) {
        if (isAsanaApiError(err)) {
          if (err.kind === "http") {
            // Map status to OutputAdapterError class.
            throw classifyHttpError({
              status: err.status,
              retryAfterHeader:
                err.retryAfterSeconds !== undefined
                  ? String(err.retryAfterSeconds)
                  : null,
              message: `asana create_task: ${err.message}`,
              cause: err,
            });
          }
          // transient
          throw classifyHttpError({
            status: 503,
            message: `asana create_task: ${err.message}`,
            cause: err,
          });
        }
        // Unknown shape — assume transient (let the BullMQ
        // wrapper retry; if it's a real bug it'll surface
        // after exhaustion). Network drops typically reach
        // here.
        throw classifyHttpError({
          status: 503,
          message: `asana create_task: unknown error (${err instanceof Error ? err.message : String(err)})`,
          cause: err,
        });
      }
    },
  };
}
