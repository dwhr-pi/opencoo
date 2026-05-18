/**
 * Vitest setup — wires testing-library + i18n bootstrapping
 * for unit tests. Each test file gets the same i18n
 * initialisation so `useTranslation` works without re-init.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

import "../../src/lib/i18n.js";

// jsdom 25.x ships HTMLDialogElement but stubs showModal/close.
// Polyfill the open/close lifecycle so the Modal primitive
// (PR-A1, wave-16) can be tested without a real browser.
// Real browsers diverge from jsdom here — the e2e suite is the
// authoritative check for top-layer + focus-trap behavior.
if (typeof HTMLDialogElement !== "undefined") {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal: () => void;
    close: (returnValue?: string) => void;
    show: () => void;
  };
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
      (this as HTMLDialogElement & { _isModal?: boolean })._isModal = true;
    };
  }
  if (typeof proto.show !== "function") {
    proto.show = function show(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function close(
      this: HTMLDialogElement,
      returnValue?: string,
    ): void {
      this.removeAttribute("open");
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.dispatchEvent(new Event("close"));
    };
  }
}

// jsdom does not implement matchMedia; the reduced-motion gating
// for the dialog enter animation reads it. Default to "not matching"
// so the animation class is applied in tests, matching the default
// browser experience for operators who have not opted out.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// jsdom 25.x logs "Not implemented: window.scrollTo" any time a
// component invokes it. The wizard re-summon path (CommandPalette
// "Run onboarding wizard" command) scrolls to top after clearing
// the dismissal flag — harmless in production, noisy in tests.
// Stub the method here so it stays no-op silent under jsdom.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", {
    writable: true,
    configurable: true,
    value: (): void => undefined,
  });
}

afterEach(() => {
  cleanup();
});
