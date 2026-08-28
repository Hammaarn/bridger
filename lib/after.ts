/**
 * Run work after the response, wherever this code happens to be running.
 *
 * The write path must not block on someone else's HTTP endpoint. A partner
 * posting a question should not wait four seconds because the other side
 * registered a webhook pointing at a host that is currently down — that would
 * make one seat's configuration a tax on the other seat's latency.
 *
 * Next's `after()` is exactly the right primitive on Vercel: the work is kept
 * alive past the response instead of being killed when the function returns.
 * But it throws outside a request scope, and this same code runs from the CLI,
 * from `tsx --test`, and from scripts. So it is attempted and, failing that,
 * the work simply starts immediately — which is correct in every one of those
 * contexts, because none of them is a serverless invocation about to be frozen.
 *
 * Errors are swallowed by construction. A background wake-up that fails must
 * never surface as a failed write; the failure is recorded on the hook itself
 * (`failCount`) where an operator can see it.
 */

import { after } from "next/server";

export function afterResponse(fn: () => Promise<unknown>): void {
  const run = () => {
    try {
      void Promise.resolve(fn()).catch(() => {});
    } catch {
      /* a synchronous throw in the scheduled work is still not the caller's problem */
    }
  };
  try {
    after(run);
  } catch {
    run();
  }
}
