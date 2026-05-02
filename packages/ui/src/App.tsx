/**
 * Root App — Sidebar + TopBar + active tab + global flows
 * (PAT entry, debug banner, logout).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { DebugBanner } from "./components/DebugBanner.js";
import { Sidebar, TopBar } from "./components/Chrome.js";
import { PatEntryModal } from "./components/PatEntryModal.js";
import {
  ApiAuthError,
  fetchAdmin,
} from "./lib/api.js";
import { clearPat, getPat, setPat } from "./lib/pat-store.js";
import { Activity } from "./routes/Activity.js";
import { Domains } from "./routes/Domains.js";
import { LlmPolicy } from "./routes/LlmPolicy.js";
import { Prompts } from "./routes/Prompts.js";
import { Reports } from "./routes/Reports.js";
import { Sources } from "./routes/Sources.js";
import type { Tab } from "./types.js";

interface CsrfResponse {
  readonly csrfToken: string;
  readonly username: string | null;
  readonly _llmDebugLogActive?: boolean;
}

export function App(): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("domains");
  const [authed, setAuthed] = useState<boolean>(() => getPat() !== null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [debugActive, setDebugActive] = useState<boolean>(false);

  useEffect((): void => {
    if (!authed) return;
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<CsrfResponse>("/api/admin/_csrf");
        setUsername(r.username);
        setDebugActive(r._llmDebugLogActive === true);
        setAuthError(null);
      } catch (err) {
        // Both auth and non-auth failures must flip `authed: false`
        // so the PatEntryModal can render the error message and let
        // the operator retry. Prior shape only flipped on
        // ApiAuthError → on a transient/network failure the error
        // string was set but the modal stayed hidden.
        if (err instanceof ApiAuthError) {
          setAuthError(
            err.status === 403
              ? t("auth.forbidden")
              : t("auth.loginFailed"),
          );
        } else {
          setAuthError(t("auth.loginFailed"));
        }
        setAuthed(false);
        clearPat();
      }
    })();
  }, [authed, t]);

  const onPatSubmit = async (pat: string): Promise<void> => {
    setPat(pat);
    setAuthed(true);
  };

  const onLogout = async (): Promise<void> => {
    try {
      await fetchAdmin("/api/admin/logout", { method: "POST" });
    } catch {
      // Server-side logout is best-effort; we always clear
      // client state regardless.
    }
    clearPat();
    setAuthed(false);
    setUsername(null);
  };

  if (!authed) {
    return (
      <PatEntryModal
        onSubmit={onPatSubmit}
        {...(authError !== null ? { error: authError } : {})}
      />
    );
  }

  const tabs: Record<Tab, JSX.Element> = {
    domains: <Domains />,
    sources: <Sources />,
    llmPolicy: <LlmPolicy />,
    prompts: <Prompts />,
    activity: <Activity />,
    reports: <Reports />,
  };

  const titles: Record<Tab, string> = {
    domains: t("domains.title"),
    sources: t("sources.title"),
    llmPolicy: t("llmPolicy.title"),
    prompts: t("prompts.title"),
    activity: t("activity.title"),
    reports: t("reports.title"),
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper)",
      }}
    >
      <DebugBanner visible={debugActive} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Sidebar tab={tab} setTab={setTab} />
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "auto",
          }}
        >
          <TopBar
            title={titles[tab]}
            username={username}
            onLogout={(): void => {
              void onLogout();
            }}
          />
          {tabs[tab]}
        </main>
      </div>
    </div>
  );
}
