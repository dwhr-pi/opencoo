/**
 * `useDeferredSkeleton` — gate skeleton rendering behind a small
 * delay so warm-cache loads (~10-30ms) don't flash a skeleton.
 *
 * Contract:
 *   - When `isLoading` is true: wait `delayMs` (default 80) before
 *     returning true. On a fast load (<delayMs) the consumer keeps
 *     rendering its previous frame; no flash.
 *   - When `isLoading` flips back to false: return false immediately
 *     and clear the pending timer.
 *   - Pending timers are cleared on unmount — no setState-after-
 *     unmount, no leak.
 *
 * The 80ms default comes from the wave-16 perceived-latency floor
 * (`docs/plan-appendix/phase-a-16-impeccable-ux.md` §"Cross-cutting
 * design decisions" — "No animation loop besides heartbeat-pulse").
 */
import { useEffect, useState } from "react";

export interface UseDeferredSkeletonOptions {
  /** Milliseconds to wait before showing the skeleton. Default 80. */
  readonly delayMs?: number;
}

export function useDeferredSkeleton(
  isLoading: boolean,
  options: UseDeferredSkeletonOptions = {},
): boolean {
  const delayMs = options.delayMs ?? 80;
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      // Flip-to-false short-circuits any pending timer: the consumer
      // wants its real data rendered now, not the skeleton after
      // the timer eventually fires.
      setShow(false);
      return undefined;
    }
    // Re-arming case: ensure we start hidden every time loading
    // flips back on, then schedule the reveal.
    setShow(false);
    const handle = setTimeout(() => {
      setShow(true);
    }, delayMs);
    return () => {
      clearTimeout(handle);
    };
  }, [isLoading, delayMs]);

  // Gate the return value on the CURRENT `isLoading` prop, not just
  // the latched `show` state. Without this AND, the render where
  // `isLoading` flips from true→false would still return true once
  // (the effect's setShow(false) runs only after commit), and a
  // consumer that reads the hook directly would paint one extra
  // skeleton frame after data lands. Triaged from PR-B1 Copilot
  // review (wave-16): the hook contract promises "false immediately
  // on flip-to-false", and the effect alone doesn't deliver that.
  return show && isLoading;
}
