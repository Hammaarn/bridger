/**
 * Health / configuration diagnostic.
 *
 * WHY THIS EXISTS
 * ---------------
 * `withMcpAuth` answers 401 with the same fixed string ("No authorization
 * provided") for every rejection — a bogus token and an unconfigured registry
 * are indistinguishable from outside. That is fine for security (telling a
 * caller *why* their token failed is free reconnaissance) and useless for
 * operations: "it 401s" has at least two very different causes, and one of them
 * is a deploy problem rather than a client problem.
 *
 * So this endpoint answers exactly one question — is the bridge configured and
 * enabled? — and deliberately answers nothing about any specific token, room or
 * entry. There is no auth on it because there is nothing here worth protecting:
 * it reports the presence of configuration, never its contents.
 */

import { createStore } from "@/lib/store";
import { envKillSwitch } from "@/lib/room-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const store = createStore();

  let registry: "ok" | "unreachable" | "not-configured" = "not-configured";
  if (store) {
    try {
      // Any read proves credentials and connectivity. The kill-switch key is
      // the cheapest one and is meaningful even when absent.
      await store.get("bridger:disabled");
      registry = "ok";
    } catch {
      registry = "unreachable";
    }
  }

  const disabled = envKillSwitch();
  const healthy = registry === "ok" && !disabled;

  return Response.json(
    {
      service: "bridger",
      version: "0.1.0",
      healthy,
      registry,
      killSwitch: disabled ? "on" : "off",
      /** The line a partner pastes. Host is derived, so it is right per deploy. */
      mcpEndpoint: "/api/mcp",
    },
    { status: healthy ? 200 : 503 },
  );
}
