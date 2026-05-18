/**
 * OnboardingWizard — inline four-step host shell for the Domains
 * route when the DB is empty (PR-B6, wave-16).
 *
 * The wizard is rendered in place of the EmptyStatePanel on
 * Domains and walks the operator through the minimal happy path
 * from a fresh install to the first heartbeat:
 *
 *   1. Create the first domain     (NewDomainModal)
 *   2. Bind the first source       (NewSourceBindingModal)
 *   3. Seed the first agent inst.  (NewAgentInstanceModal)
 *   4. Wait for the first heartbeat (polls /api/admin/heartbeat/preconditions)
 *
 * Each step has four observable states:
 *   - `idle`    — gated; previous step not yet done. CTA disabled.
 *   - `pending` — current actionable step; CTA primary.
 *   - `done`    — list endpoint reports >= 1 row (or, for step 4,
 *                  the preconditions report a successful run with
 *                  output).
 *   - `failed`  — reserved for future hard-error transitions; the
 *                  current implementation never emits this state
 *                  but the Badge tone is wired so a follow-up can
 *                  surface API errors per-step.
 *
 * Threat-model invariants:
 *   - Read-only client surface — every step's "done" check polls
 *     the same admin-team-gated GET that already exists. The
 *     wizard does NOT POST anything; the actual creates happen
 *     through the existing New*Modal flows, which run through
 *     the same `fetchAdmin` POST path with CSRF + audit-log
 *     bookkeeping every other create uses.
 *   - The `localStorage.opencoo_onboarding_dismissed` flag is
 *     client-only UI state — losing it just re-shows the wizard,
 *     which is harmless.
 *
 * Design-system constraints (CLAUDE.md "Hard nos"):
 *   - No gradients, no drop shadows, no emoji, no marketing voice.
 *   - Depth via border + paper-2 only.
 *   - Healthy Green only on the `done` Badge; everything else uses
 *     neutral tones. No `--alert` until a step actually fails.
 *
 * Polling cadence: step 4 polls `/api/admin/heartbeat/preconditions`
 * every 4 seconds via a chained `setTimeout` (cancels on unmount,
 * on dismissal, and the moment a successful run is detected). The
 * 4 s budget is conservative — heartbeats are minutes apart in
 * practice; faster polling would just add admin-API noise.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { HeartbeatPreconditions } from "../types.js";

import { Badge, type BadgeTone } from "./Badge.js";
import { Btn } from "./Btn.js";
import { Card } from "./Card.js";
import { NewAgentInstanceModal } from "./NewAgentInstanceModal.js";
import { NewDomainModal } from "./NewDomainModal.js";
import { NewSourceBindingModal } from "./NewSourceBindingModal.js";

export const ONBOARDING_DISMISSED_KEY = "opencoo_onboarding_dismissed";
const POLL_INTERVAL_MS = 4000;

type StepKey = "domain" | "source" | "agent" | "heartbeat";
type StepStatus = "idle" | "pending" | "done" | "failed";

interface StepState {
  readonly key: StepKey;
  readonly status: StepStatus;
}

export interface OnboardingWizardProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Fires after the operator clicks "Skip wizard". Lets the
   *  hosting route swap back to the original EmptyStatePanel
   *  without a re-mount of the wizard state machine. */
  readonly onDismissed?: () => void;
  /** @internal Test seam — override the step-4 polling cadence.
   *  Defaults to 4 s in production; tests can drop it to a few
   *  tens of milliseconds to keep run-time short without
   *  resorting to fake-timer microtask gymnastics. */
  readonly pollIntervalMs?: number;
}

interface DomainsResponse {
  readonly rows: ReadonlyArray<unknown>;
}
interface BindingsResponse {
  readonly rows: ReadonlyArray<unknown>;
}
interface InstancesResponse {
  readonly rows: ReadonlyArray<unknown>;
}

/** Translate the wizard's step status into a Badge tone. Done is
 *  the only Healthy Green moment per screen; the rest stay
 *  neutral so the operator's eye lands on the actionable step. */
function badgeTone(status: StepStatus): BadgeTone {
  switch (status) {
    case "done":
      return "ok";
    case "failed":
      return "alert";
    case "pending":
    case "idle":
    default:
      return "neutral";
  }
}

function isHeartbeatDone(pre: HeartbeatPreconditions): boolean {
  if (pre.heartbeatInstanceCount === 0) return false;
  if (pre.enabledHeartbeatInstanceCount === 0) return false;
  if (pre.mostRecentRun === null) return false;
  if (pre.mostRecentRun.status !== "success") return false;
  if (pre.mostRecentRun.outputIsNull) return false;
  return true;
}

const HEADER_BAND_STYLE: CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid var(--rule)",
  background: "var(--paper-2)",
  borderTopLeftRadius: "var(--radius-l)",
  borderTopRightRadius: "var(--radius-l)",
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  color: "var(--ink)",
};

const INTRO_STYLE: CSSProperties = {
  marginTop: 6,
  marginBottom: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--ink-2)",
  lineHeight: 1.5,
};

const STEP_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "20px",
};

const STEP_ROW_BASE: CSSProperties = {
  border: "1px solid var(--rule)",
  borderRadius: 6,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--paper)",
};

const STEP_ROW_DISABLED: CSSProperties = {
  ...STEP_ROW_BASE,
  background: "var(--paper-3)",
  color: "var(--ink-3)",
};

const STEP_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};

const STEP_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink)",
};

const STEP_TITLE_DISABLED_STYLE: CSSProperties = {
  ...STEP_TITLE_STYLE,
  color: "var(--ink-3)",
};

const STEP_BODY_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--ink-2)",
  lineHeight: 1.5,
  margin: 0,
};

const STEP_BODY_DISABLED_STYLE: CSSProperties = {
  ...STEP_BODY_STYLE,
  color: "var(--ink-3)",
};

const FOOTER_STYLE: CSSProperties = {
  padding: "12px 20px 16px",
  borderTop: "1px solid var(--rule)",
  display: "flex",
  justifyContent: "flex-end",
};

const SKIP_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  cursor: "pointer",
  padding: "4px 6px",
};

export function OnboardingWizard(props: OnboardingWizardProps): JSX.Element {
  const { t } = useTranslation();
  const fetchOpts = useMemo(
    () => fetchOptsFor(props.fetchImpl),
    [props.fetchImpl],
  );

  // Per-step "done" signals. Step 1-3 are derived from list-row
  // counts (>= 1 row → done); step 4 from the preconditions
  // success-run probe.
  const [domainDone, setDomainDone] = useState(false);
  const [sourceDone, setSourceDone] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [heartbeatDone, setHeartbeatDone] = useState(false);

  // Refresh nonces let the per-step modals trigger a re-fetch
  // when they emit `onCreated` — without this, the wizard would
  // sit on the stale `rows: []` snapshot until the operator
  // refreshes the page.
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Active modal — null when no modal is open. The CTA per step
  // sets one of the keys; the modal's onCreated/onClose clears it
  // and bumps refreshNonce so the next list-poll re-checks the
  // step's done signal.
  const [activeModal, setActiveModal] = useState<StepKey | null>(null);

  // ── Step 1-3 polling: one effect each, gated on previous-step
  //    done so we don't fire pointless GETs against the admin API
  //    while the operator is still on step 1.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchAdmin<DomainsResponse>(
          "/api/admin/domains",
          fetchOpts,
        );
        if (cancelled) return;
        setDomainDone((r.rows ?? []).length >= 1);
      } catch {
        // Swallow — the next refresh tick retries. The wizard
        // surfaces a failure on the step row once we wire the
        // "failed" status path (deferred to a follow-up).
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [fetchOpts, refreshNonce]);

  useEffect(() => {
    if (!domainDone) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchAdmin<BindingsResponse>(
          "/api/admin/source-bindings",
          fetchOpts,
        );
        if (cancelled) return;
        setSourceDone((r.rows ?? []).length >= 1);
      } catch {
        // ignore
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [fetchOpts, refreshNonce, domainDone]);

  useEffect(() => {
    if (!sourceDone) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchAdmin<InstancesResponse>(
          "/api/admin/agent-instances",
          fetchOpts,
        );
        if (cancelled) return;
        setAgentDone((r.rows ?? []).length >= 1);
      } catch {
        // ignore
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [fetchOpts, refreshNonce, agentDone, sourceDone]);

  // ── Step 4 polling: chained setTimeout so test-time fake-timer
  //    advances drive a fresh fetch per tick. Polling stops on:
  //      - successful detection (heartbeatDone → true)
  //      - dismissal (onDismissed callback fires; cancelled flag)
  //      - unmount (cleanup tears down the timeout)
  //
  //    We mirror `heartbeatDone` into a ref so the scheduler
  //    doesn't restart on every state change — the timeout body
  //    reads the ref, sets state, and re-schedules only when the
  //    ref says we're not yet done.
  const heartbeatDoneRef = useRef(heartbeatDone);
  heartbeatDoneRef.current = heartbeatDone;
  const dismissedRef = useRef(false);
  const fetchImplRef = useRef(props.fetchImpl);
  fetchImplRef.current = props.fetchImpl;

  useEffect(() => {
    if (!agentDone) return;
    if (heartbeatDoneRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      if (cancelled || dismissedRef.current) return;
      try {
        const r = await fetchAdmin<HeartbeatPreconditions>(
          "/api/admin/heartbeat/preconditions",
          fetchOptsFor(fetchImplRef.current),
        );
        if (cancelled || dismissedRef.current) return;
        if (isHeartbeatDone(r)) {
          setHeartbeatDone(true);
          heartbeatDoneRef.current = true;
          return;
        }
      } catch {
        // ignore — retry next tick
      }
      if (cancelled || dismissedRef.current) return;
      if (heartbeatDoneRef.current) return;
      timer = setTimeout(() => {
        void poll();
      }, props.pollIntervalMs ?? POLL_INTERVAL_MS);
    };
    void poll();

    return (): void => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [agentDone, props.pollIntervalMs]);

  // ── Step status derivation. The first not-done step is
  //    `pending`; subsequent steps are `idle`; preceding (done)
  //    steps are `done`.
  const steps: ReadonlyArray<StepState> = useMemo(() => {
    const doneFlags: Record<StepKey, boolean> = {
      domain: domainDone,
      source: sourceDone,
      agent: agentDone,
      heartbeat: heartbeatDone,
    };
    const order: ReadonlyArray<StepKey> = [
      "domain",
      "source",
      "agent",
      "heartbeat",
    ];
    let pendingAssigned = false;
    return order.map((key) => {
      if (doneFlags[key]) return { key, status: "done" as StepStatus };
      if (!pendingAssigned) {
        pendingAssigned = true;
        return { key, status: "pending" as StepStatus };
      }
      return { key, status: "idle" as StepStatus };
    });
  }, [domainDone, sourceDone, agentDone, heartbeatDone]);

  const onSkip = useCallback((): void => {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // localStorage can throw under quota / private-mode in some
      // browsers; ignore — the wizard still dismisses for this
      // session via the parent callback.
    }
    dismissedRef.current = true;
    props.onDismissed?.();
  }, [props]);

  const onModalCreated = useCallback((): void => {
    setActiveModal(null);
    setRefreshNonce((n) => n + 1);
  }, []);

  const closeModal = useCallback((): void => {
    setActiveModal(null);
  }, []);

  return (
    <div data-testid="onboarding-wizard">
      <Card>
        <div style={HEADER_BAND_STYLE}>
          <h2 style={TITLE_STYLE}>{t("onboarding.title")}</h2>
          <p style={INTRO_STYLE}>{t("onboarding.intro")}</p>
        </div>
        <div style={STEP_LIST_STYLE}>
          {steps.map((step, idx) => (
            <StepRow
              key={step.key}
              index={idx + 1}
              stepKey={step.key}
              status={step.status}
              onCta={(): void => setActiveModal(step.key)}
            />
          ))}
        </div>
        <div style={FOOTER_STYLE}>
          <button
            type="button"
            style={SKIP_BTN_STYLE}
            onClick={onSkip}
            data-testid="onboarding-skip"
          >
            {t("onboarding.skip")}
          </button>
        </div>
      </Card>
      {activeModal === "domain" ? (
        <NewDomainModal
          {...fetchOpts}
          onCreated={onModalCreated}
          onClose={closeModal}
        />
      ) : null}
      {activeModal === "source" ? (
        <NewSourceBindingModal
          {...fetchOpts}
          onCreated={onModalCreated}
          onClose={closeModal}
        />
      ) : null}
      {activeModal === "agent" ? (
        <NewAgentInstanceModal
          {...fetchOpts}
          onCreated={onModalCreated}
          onClose={closeModal}
        />
      ) : null}
    </div>
  );
}

interface StepRowProps {
  readonly index: number;
  readonly stepKey: StepKey;
  readonly status: StepStatus;
  readonly onCta: () => void;
}

function StepRow(props: StepRowProps): JSX.Element {
  const { t } = useTranslation();
  const { index, stepKey, status, onCta } = props;
  const isIdle = status === "idle";
  // The heartbeat step has no operator-driven CTA — it just
  // watches. We disable the CTA + render the "Watching for run…"
  // label so the affordance still has something to read but the
  // operator doesn't click it expecting a modal.
  const isHeartbeat = stepKey === "heartbeat";
  const ctaDisabled = isIdle || status === "done" || isHeartbeat;
  const rowStyle: CSSProperties = isIdle ? STEP_ROW_DISABLED : STEP_ROW_BASE;
  const titleStyle: CSSProperties = isIdle
    ? STEP_TITLE_DISABLED_STYLE
    : STEP_TITLE_STYLE;
  const bodyStyle: CSSProperties = isIdle
    ? STEP_BODY_DISABLED_STYLE
    : STEP_BODY_STYLE;

  return (
    <div
      data-testid={`onboarding-step-${index}`}
      data-step-key={stepKey}
      data-step-status={status}
      style={rowStyle}
    >
      <div style={STEP_HEADER_STYLE}>
        <h3 style={titleStyle}>
          <span style={{ marginRight: 8, color: "var(--ink-3)" }}>
            {String(index).padStart(2, "0")}
          </span>
          {t(`onboarding.steps.${stepKey}.title`)}
        </h3>
        <Badge tone={badgeTone(status)}>
          {t(`onboarding.stepStatus.${status}`)}
        </Badge>
      </div>
      <p style={bodyStyle}>{t(`onboarding.steps.${stepKey}.body`) as ReactNode}</p>
      <div>
        <Btn
          variant={status === "pending" ? "primary" : "ghost"}
          disabled={ctaDisabled}
          onClick={onCta}
        >
          {t(`onboarding.steps.${stepKey}.ctaLabel`)}
        </Btn>
      </div>
    </div>
  );
}
