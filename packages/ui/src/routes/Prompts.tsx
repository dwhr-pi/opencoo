/**
 * Prompts tab — per-domain prompt-override editor (PR-W7a,
 * phase-a appendix #15).
 *
 * Rebuild of the v0.1 read-only manifest grid into a left-rail
 * picker (9 prompts × Knowledge|Operate groups) + right-pane
 * editor (domain dropdown + locale tabs + textarea). The Save
 * flow goes through PR-W2's `/preview` → DiffPreviewDialog →
 * `/apply` chain with the sovereignty-confirm token. The
 * lagging-overrides banner at the top aggregates every
 * `isStale: true` override across all domains so an operator
 * arriving on the tab sees "X prompts on Y domains are forked
 * from an outdated baseline" without drilling in.
 *
 * Reuse-list:
 *   - `DiffPreviewDialog` (drop-in; extended to accept line-
 *     level diff in this PR).
 *   - `PromptsDiffBanner` (existing; just fed real `lagging`).
 *   - `Card` / `Btn` / `Modal` (design-system primitives).
 *
 * The route degrades gracefully on a fresh deployment: when no
 * overrides exist anywhere, the lagging banner stays hidden and
 * the editor shows the shipped baseline body for the picked
 * (prompt, domain, locale).
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 * `--alert` only on the validation-error banner (border +
 * color-mix background); the `PromptsDiffBanner` itself uses
 * `--wiki` because the lagging-overrides callout points at
 * compiled-knowledge chrome (prompt-name path tokens).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/Card.js";
import { DiffPreviewDialog } from "../components/DiffPreviewDialog.js";
import { Display } from "../components/Display.js";
import { PromptDebugDrawer } from "../components/PromptDebugDrawer.js";
import { PromptEditor } from "../components/PromptEditor.js";
import { PromptsDiffBanner } from "../components/PromptsDiffBanner.js";
import { RevertOverrideModal } from "../components/RevertOverrideModal.js";
import { ApiValidationError, fetchAdmin, fetchOptsFor } from "../lib/api.js";
import {
  markRouteFetchEnd,
  markRouteFetchStart,
  measureRouteNav,
} from "../lib/perf-marks.js";
import type {
  Domain,
  PromptManifestEntry,
  PromptOverridePreview,
} from "../types.js";

type PromptName =
  | "classifier"
  | "compiler"
  | "heartbeat"
  | "lint"
  | "chat"
  | "surfacer"
  | "builder"
  | "worldview-domain"
  | "worldview-company";

type Locale = "en" | "pl";

/** The 9 shipped prompts grouped by role. Knowledge prompts
 *  compile pages + worldviews; Operate prompts drive the
 *  always-on agents. The sidebar uses this grouping to make
 *  the 9-item list scannable. The list is intentionally
 *  duplicated here rather than imported from `@opencoo/shared`
 *  — the UI package has no shared dependency, and a future
 *  prompt addition is a one-line edit either way. */
const PROMPT_GROUPS: ReadonlyArray<{
  readonly key: "knowledge" | "operate";
  readonly names: ReadonlyArray<PromptName>;
}> = [
  {
    key: "knowledge",
    names: ["classifier", "compiler", "worldview-domain", "worldview-company"],
  },
  {
    key: "operate",
    names: ["heartbeat", "lint", "chat", "surfacer", "builder"],
  },
];

interface ListedOverrideRow {
  readonly name: PromptName;
  readonly locale: Locale;
  readonly overridesVersion: string;
  readonly baselineVersion: string;
  readonly isStale: boolean;
  readonly updatedAt: string;
  readonly updatedByUsername: string | null;
}

interface DomainPromptsResponse {
  readonly overrides: ReadonlyArray<ListedOverrideRow>;
  readonly baselines: ReadonlyArray<{
    readonly name: PromptName;
    readonly locale: Locale;
    readonly version: string;
    readonly body: string;
  }>;
}

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain>;
}

interface SinglePromptResponse {
  readonly name: PromptName;
  readonly locale: Locale;
  readonly scope: "domains" | "agent-instances";
  readonly body: string;
  readonly version: string;
  readonly source: "baseline" | "override";
  readonly baselineVersion?: string;
  readonly isStale?: boolean;
}

interface PromptsManifestResponse {
  readonly entries: ReadonlyArray<PromptManifestEntry>;
}

interface ApplyDriftBody {
  readonly error: "baseline_version_drifted";
  readonly previewBaselineVersion: string;
  readonly currentBaselineVersion: string;
}

interface LaggingRow {
  readonly domainSlug: string;
  readonly name: PromptName;
  readonly locale: Locale;
  readonly overridesVersion: string;
  readonly currentBaselineVersion: string;
}

const PAGE_STYLE: CSSProperties = {
  padding: "24px 28px",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const LAYOUT_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "240px 1fr",
  gap: 16,
};

const LEFT_RAIL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const GROUP_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--fg-3)",
  paddingInline: "8px",
  marginTop: 4,
};

const PROMPT_BTN_STYLE: CSSProperties = {
  textAlign: "left",
  font: "inherit",
  padding: "6px 8px",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  cursor: "pointer",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  color: "var(--fg-1)",
};

const PROMPT_BTN_ACTIVE_STYLE: CSSProperties = {
  ...PROMPT_BTN_STYLE,
  background: "var(--paper-2)",
  borderColor: "var(--rule)",
};

const ERROR_BANNER_STYLE: CSSProperties = {
  border: "1px solid var(--alert)",
  background: "color-mix(in oklch, var(--alert) 8%, var(--paper))",
  padding: "var(--space-3) var(--space-4)",
  borderRadius: 3,
  color: "var(--alert)",
};

export interface PromptsProps {
  /** @internal Test seam — defaults to globalThis.fetch via
   *  fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
  /** When the operator arrives from the Domains tab's drill-
   *  down, this pre-selects the domain in the right-pane
   *  picker. The route resolves it once domains land; manual
   *  selections persist across re-renders. */
  readonly initialDomainId?: string;
  /** PR-W10 — Cmd-K palette prompt-name pre-select. When set,
   *  the route opens the named prompt's editor instead of the
   *  empty prompt-picker. (Copilot triage on PR-W10.) */
  readonly initialPromptName?: PromptName;
  /** PR-W10 follow-up — Consume signal. Fired once the route
   *  has used `initialPromptName` to seed the picker; App.tsx
   *  clears its `promptsInitialName` state so re-mounting this
   *  tab (e.g. via sidebar away-and-back) doesn't re-apply the
   *  stale palette pick. */
  readonly onInitialPromptNameConsumed?: () => void;
}

export function Prompts(props: PromptsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const fetchOpts = fetchOptsFor(props.fetchImpl);

  // Manifest of shipped versions per prompt name.
  const [manifest, setManifest] = useState<Record<string, string> | null>(
    null,
  );

  // Top-level state.
  const [domains, setDomains] = useState<ReadonlyArray<Domain> | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptName | null>(
    props.initialPromptName ?? null,
  );
  // PR-W10 follow-up — consume `initialPromptName` once on mount
  // so App.tsx can clear its `promptsInitialName` state. Without
  // this, a Cmd-K palette pick + sidebar away-and-back would
  // re-apply the stale pre-select. (Copilot triage on PR-154.)
  const onInitialPromptNameConsumed = props.onInitialPromptNameConsumed;
  // Mount-only consume: capture the initial values once and fire
  // the callback on first paint. Deps intentionally empty — we
  // don't want to re-fire if the parent passes a different
  // `initialPromptName` later (the consume signal is the parent's
  // cue to stop passing it).
  const initialPromptNameRef = useRef(props.initialPromptName);
  useEffect((): void => {
    if (initialPromptNameRef.current !== undefined) {
      onInitialPromptNameConsumed?.();
    }
  }, [onInitialPromptNameConsumed]);
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(
    props.initialDomainId ?? null,
  );
  const [selectedLocale, setSelectedLocale] = useState<Locale>("en");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [lagging, setLagging] = useState<ReadonlyArray<LaggingRow>>([]);

  // Right-pane state.
  const [current, setCurrent] = useState<SinglePromptResponse | null>(null);
  const [proposedBody, setProposedBody] = useState<string>("");
  const [paneError, setPaneError] = useState<string | null>(null);
  const [paneLoading, setPaneLoading] = useState<boolean>(false);

  // Preview / apply flow.
  const [preview, setPreview] = useState<PromptOverridePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [drift, setDrift] = useState<{
    readonly previewBaselineVersion: string;
    readonly currentBaselineVersion: string;
  } | null>(null);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  // Modals + drawers.
  const [revertOpen, setRevertOpen] = useState<boolean>(false);
  const [debugOpen, setDebugOpen] = useState<boolean>(false);

  // Refresh nonces.
  const [paneNonce, setPaneNonce] = useState<number>(0);
  const [laggingNonce, setLaggingNonce] = useState<number>(0);

  // PR-B8+ (wave-17) — first-fetch-only nav measure (see
  // Domains.tsx). The manifest fetch is the route's earliest
  // bootstrap, so the bracket lives here. The parallel
  // domains+lagging effect below is captured end-to-end by the
  // resulting `route:prompts:nav` measure.
  const didMeasureNavRef = useRef(false);

  // ----- bootstrap: load manifest -----
  useEffect((): void => {
    markRouteFetchStart("prompts");
    void (async (): Promise<void> => {
      try {
        const m = await fetchAdmin<PromptsManifestResponse>(
          "/api/admin/prompts",
          fetchOpts,
        );
        const mm: Record<string, string> = {};
        for (const e of m.entries) {
          if (e.locales.length > 0) {
            mm[e.name] = e.locales[0]!.version;
          }
        }
        setManifest(mm);
      } catch (err) {
        setBootstrapError(err instanceof Error ? err.message : String(err));
      } finally {
        markRouteFetchEnd("prompts");
        if (!didMeasureNavRef.current) {
          didMeasureNavRef.current = true;
          measureRouteNav("prompts");
        }
      }
    })();
  }, []);

  // ----- bootstrap: load domains + aggregate lagging -----
  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<DomainsResponse>(
          "/api/admin/domains",
          fetchOpts,
        );
        setDomains(r.rows);
        // Fan-out one request per domain. Typical deployments
        // have 3–8 domains so this stays cheap. v0.2 may collapse
        // into a server-side aggregate endpoint if the count
        // grows.
        const perDomain = await Promise.all(
          r.rows.map(async (d) => {
            try {
              const res = await fetchAdmin<DomainPromptsResponse>(
                `/api/admin/domains/${d.id}/prompts`,
                fetchOpts,
              );
              return { slug: d.slug, overrides: res.overrides };
            } catch {
              return {
                slug: d.slug,
                overrides: [] as ReadonlyArray<ListedOverrideRow>,
              };
            }
          }),
        );
        const aggregated: LaggingRow[] = [];
        for (const entry of perDomain) {
          for (const o of entry.overrides) {
            if (o.isStale) {
              aggregated.push({
                domainSlug: entry.slug,
                name: o.name,
                locale: o.locale,
                overridesVersion: o.overridesVersion,
                currentBaselineVersion: o.baselineVersion,
              });
            }
          }
        }
        setLagging(aggregated);
      } catch (err) {
        setBootstrapError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [laggingNonce]);

  useEffect((): void => {
    if (domains === null) return;
    if (selectedDomainId === null && domains.length > 0) {
      setSelectedDomainId(domains[0]!.id);
    }
  }, [domains, selectedDomainId]);

  // ----- reset preview/notice/drift when (prompt, domain,
  //       locale) change. Bumping paneNonce after an apply only
  //       re-fetches the body; the applied-notice toast stays
  //       visible until the operator navigates away. -----
  useEffect((): void => {
    setPreview(null);
    setAppliedNotice(null);
    setDrift(null);
    setPreviewError(null);
  }, [selectedPrompt, selectedDomainId, selectedLocale]);

  // ----- right-pane fetch on (prompt, domain, locale, nonce) -----
  useEffect((): void => {
    if (selectedPrompt === null || selectedDomainId === null) {
      setCurrent(null);
      return;
    }
    setPaneLoading(true);
    setPaneError(null);
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<SinglePromptResponse>(
          `/api/admin/domains/${selectedDomainId}/prompts/${selectedPrompt}/${selectedLocale}`,
          fetchOpts,
        );
        setCurrent(r);
        setProposedBody(r.body);
      } catch (err) {
        setPaneError(err instanceof Error ? err.message : String(err));
      } finally {
        setPaneLoading(false);
      }
    })();
  }, [selectedPrompt, selectedDomainId, selectedLocale, paneNonce]);

  // ----- error mapper -----
  const mapApplyError = (err: unknown): string => {
    if (err instanceof ApiValidationError) {
      const body = err.body as { error?: string; reason?: string } | undefined;
      if (body?.reason === "payload_mismatch") {
        return t("prompts.editor.errors.payloadMismatch");
      }
      if (body?.reason === "expired") {
        return t("prompts.editor.errors.expired");
      }
      if (body?.reason === "signature_mismatch") {
        return t("prompts.editor.errors.signatureMismatch");
      }
    }
    return err instanceof Error ? err.message : String(err);
  };

  // ----- preview -----
  const onPreview = async (): Promise<void> => {
    if (selectedDomainId === null || selectedPrompt === null) return;
    setPreviewError(null);
    setDrift(null);
    try {
      const r = await fetchAdmin<PromptOverridePreview>(
        `/api/admin/domains/${selectedDomainId}/prompts/${selectedPrompt}/${selectedLocale}/preview`,
        { method: "POST", body: { proposedBody }, ...fetchOpts },
      );
      setPreview(r);
    } catch (err) {
      setPreviewError(mapApplyError(err));
    }
  };

  // ----- apply -----
  const onApply = async (): Promise<void> => {
    if (
      selectedDomainId === null ||
      selectedPrompt === null ||
      preview === null
    ) {
      return;
    }
    try {
      await fetchAdmin(
        `/api/admin/domains/${selectedDomainId}/prompts/${selectedPrompt}/${selectedLocale}/apply`,
        {
          method: "POST",
          body: {
            proposedBody,
            token: preview.token,
            confirmDiff: true,
            baselineVersion: preview.baselineVersion,
          },
          ...fetchOpts,
        },
      );
      setPreview(null);
      setAppliedNotice(t("prompts.editor.appliedToast"));
      setPaneNonce((n) => n + 1);
      setLaggingNonce((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiValidationError) {
        const body = err.body as Partial<ApplyDriftBody> | undefined;
        if (body?.error === "baseline_version_drifted") {
          setPreview(null);
          setDrift({
            previewBaselineVersion: body.previewBaselineVersion ?? "",
            currentBaselineVersion: body.currentBaselineVersion ?? "",
          });
          return;
        }
      }
      setPreviewError(mapApplyError(err));
    }
  };

  // ----- re-fork from new baseline -----
  const onRefork = (): void => {
    setDrift(null);
    setPaneNonce((n) => n + 1);
  };

  // ----- revert (DELETE) -----
  const onRevertConfirm = async (): Promise<void> => {
    if (selectedDomainId === null || selectedPrompt === null) return;
    try {
      await fetchAdmin(
        `/api/admin/domains/${selectedDomainId}/prompts/${selectedPrompt}/${selectedLocale}`,
        { method: "DELETE", ...fetchOpts },
      );
      setRevertOpen(false);
      setAppliedNotice(t("prompts.editor.revertedToast"));
      setPaneNonce((n) => n + 1);
      setLaggingNonce((n) => n + 1);
    } catch (err) {
      setPreviewError(mapApplyError(err));
      setRevertOpen(false);
    }
  };

  const diffSubtitle = useMemo(() => {
    if (selectedPrompt === null || selectedDomainId === null) return "";
    const slug = domains?.find((d) => d.id === selectedDomainId)?.slug ?? "";
    return `${selectedPrompt} · ${slug} · ${selectedLocale}`;
  }, [selectedPrompt, selectedDomainId, selectedLocale, domains]);

  const laggingForBanner = lagging.map((row) => ({
    name: `${row.name} · ${row.domainSlug}/${row.locale}`,
    currentVersion: row.overridesVersion,
    defaultVersion: row.currentBaselineVersion,
  }));

  const currentWithManifest: SinglePromptResponse | null = useMemo(() => {
    if (current === null) return null;
    const manifestVersion = manifest?.[current.name];
    return {
      ...current,
      baselineVersion:
        current.baselineVersion ?? manifestVersion ?? current.version,
    };
  }, [current, manifest]);

  return (
    <div style={PAGE_STYLE}>
      <div>
        <h1 id="opencoo-page-h1" style={{ margin: 0 }}>{t("prompts.title")}</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>
          {t("prompts.subtitleEditor")}
        </p>
      </div>
      {bootstrapError !== null ? (
        <div style={ERROR_BANNER_STYLE} role="alert">
          {bootstrapError}
        </div>
      ) : null}
      <PromptsDiffBanner lagging={laggingForBanner} />
      <div style={LAYOUT_STYLE}>
        <Card>
          <div style={LEFT_RAIL_STYLE}>
            {PROMPT_GROUPS.map((group) => (
              <div key={group.key}>
                <div style={GROUP_LABEL_STYLE}>
                  {t(`prompts.groups.${group.key}`)}
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 2 }}
                >
                  {group.names.map((name) => (
                    <button
                      key={name}
                      type="button"
                      data-testid={`prompt-pick-${name}`}
                      onClick={(): void => {
                        setSelectedPrompt(name);
                      }}
                      style={
                        selectedPrompt === name
                          ? PROMPT_BTN_ACTIVE_STYLE
                          : PROMPT_BTN_STYLE
                      }
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          {selectedPrompt === null ? (
            // Empty-pane lede — PR-C4 (wave-16). The serif italic
            // family wraps the existing explainer when no prompt is
            // picked. `as="p"` keeps the heading outline clean (the
            // route already carries an h1 above) while the C4
            // ESLint rule + cross-route snapshot test pin this as
            // one of three legal placements.
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Display level={2} as="p">
                {t("routes.prompts.lede")}
              </Display>
              <div style={{ color: "var(--ink-3)" }}>
                {t("prompts.editor.empty")}
              </div>
            </div>
          ) : paneLoading ? (
            <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
          ) : paneError !== null ? (
            <div style={ERROR_BANNER_STYLE} role="alert">
              {paneError}
            </div>
          ) : currentWithManifest !== null && selectedDomainId !== null ? (
            <PromptEditor
              promptName={selectedPrompt}
              domainId={selectedDomainId}
              domains={domains ?? []}
              locale={selectedLocale}
              current={currentWithManifest}
              proposedBody={proposedBody}
              onDomainChange={(id): void => setSelectedDomainId(id)}
              onLocaleChange={(l): void => setSelectedLocale(l)}
              onProposedBodyChange={setProposedBody}
              onPreview={(): void => void onPreview()}
              onRevert={(): void => setRevertOpen(true)}
              onOpenDebug={(): void => setDebugOpen(true)}
              previewError={previewError}
              drift={drift}
              onRefork={onRefork}
              appliedNotice={appliedNotice}
            />
          ) : null}
        </Card>
      </div>
      {preview !== null ? (
        <DiffPreviewDialog
          preview={preview}
          subtitle={diffSubtitle}
          onApply={onApply}
          onCancel={(): void => setPreview(null)}
          errorMessage={previewError}
        />
      ) : null}
      {revertOpen ? (
        <RevertOverrideModal
          promptName={selectedPrompt ?? ""}
          onConfirm={(): void => void onRevertConfirm()}
          onClose={(): void => setRevertOpen(false)}
        />
      ) : null}
      {debugOpen && selectedPrompt !== null && selectedDomainId !== null ? (
        <PromptDebugDrawer
          {...fetchOpts}
          promptName={selectedPrompt}
          domainId={selectedDomainId}
          onClose={(): void => setDebugOpen(false)}
        />
      ) : null}
    </div>
  );
}
