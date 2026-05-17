/**
 * `useDeferredSkeleton` tests — PR-B1 (wave-16, phase-a appendix #16).
 *
 * The hook prevents the "skeleton flash" for sub-80ms loads typical
 * of warm-cache admin-API calls (~150-300ms cold, ~10-30ms warm).
 *
 * Contract:
 *   - Returns `false` synchronously on the first render even if
 *     `isLoading` is true (the deferral has not yet elapsed).
 *   - Returns `true` only after `delayMs` has passed AND
 *     `isLoading` is still true.
 *   - Returns `false` immediately when `isLoading` flips to false,
 *     even mid-delay; the pending timer must be cleared.
 *   - No timer leak after unmount — pending timers must be cleared
 *     to avoid "setState on unmounted component" warnings.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, render, act } from "@testing-library/react";

import { useDeferredSkeleton } from "../../src/hooks/useDeferredSkeleton.js";

describe("useDeferredSkeleton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false synchronously when loading just flipped to true", () => {
    const { result } = renderHook(({ loading }) => useDeferredSkeleton(loading), {
      initialProps: { loading: true },
    });
    // Pre-delay: skeleton is hidden so a fast load doesn't flash.
    expect(result.current).toBe(false);
  });

  it("returns true after the default 80ms delay has elapsed", () => {
    const { result } = renderHook(({ loading }) => useDeferredSkeleton(loading), {
      initialProps: { loading: true },
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(79);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("honors a custom delayMs option", () => {
    const { result } = renderHook(
      ({ loading }) => useDeferredSkeleton(loading, { delayMs: 200 }),
      { initialProps: { loading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe(true);
  });

  it("returns false immediately when isLoading flips to false mid-delay", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDeferredSkeleton(loading),
      { initialProps: { loading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(result.current).toBe(false);
    rerender({ loading: false });
    // No more advancement needed — the flip-to-false must short-
    // circuit the pending timer and return false on the next render.
    expect(result.current).toBe(false);
    // Even after the original delay would have elapsed: still false.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(false);
  });

  it("returns false immediately when isLoading flips to false after the delay", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDeferredSkeleton(loading),
      { initialProps: { loading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);
    rerender({ loading: false });
    expect(result.current).toBe(false);
  });

  it("re-arms the delay when isLoading flips back to true", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDeferredSkeleton(loading),
      { initialProps: { loading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);
    rerender({ loading: false });
    expect(result.current).toBe(false);
    rerender({ loading: true });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current).toBe(true);
  });

  it("contracts: rendered value equals (show && isLoading) per render", () => {
    // Triaged from PR-B1 Copilot review: the hook's setShow(false)
    // in the flip-to-false branch runs in an effect, AFTER commit.
    // The hook therefore gates its return value on the CURRENT
    // `isLoading` prop (`show && isLoading`) — not just the
    // latched `show` state — so consumers reading the hook never
    // see one stale skeleton frame after data lands.
    //
    // The render-time bug ("returns stale `show` once") is hard to
    // observe under `@testing-library/react`'s `act`-wrapped
    // `rerender`, which flushes pending effects before the test
    // sees the next render. This test is therefore a CONTRACT
    // assertion, not a regression catcher: it asserts the rendered
    // value matches the per-render expectation, locking the AND
    // gate in place.
    const history: { loading: boolean; result: boolean }[] = [];
    function Probe({ loading }: { loading: boolean }): null {
      const v = useDeferredSkeleton(loading);
      history.push({ loading, result: v });
      return null;
    }
    const { rerender } = render(<Probe loading={true} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<Probe loading={false} />);
    // The contract: result is FALSE on every render where
    // `loading` is false — no exceptions. (When loading is true,
    // the result depends on whether the 80ms delay has elapsed.)
    for (const entry of history) {
      if (!entry.loading) {
        expect(entry.result).toBe(false);
      }
    }
  });

  it("does not leak pending timers after unmount", () => {
    const { result, unmount } = renderHook(({ loading }) =>
      useDeferredSkeleton(loading),
      { initialProps: { loading: true } },
    );
    expect(result.current).toBe(false);
    unmount();
    // If the unmounted hook's timer fired, it would attempt to
    // setState on an unmounted component. With fake timers we can
    // assert that NO timers remain pending after unmount.
    expect(vi.getTimerCount()).toBe(0);
  });
});
