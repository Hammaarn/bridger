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

import { createStore, DEFAULT_DAILY_CAP, KILL_SWITCH, RATE_LIMIT_PER_MINUTE } from "@/lib/store";
import { envKillSwitch } from "@/lib/room-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const store = createStore();

  let registry: "ok" | "unreachable" | "not-configured" = "not-configured";
  let redisSwitch = false;
  if (store) {
    try {
      // The same read serves both purposes: it proves credentials and
      // connectivity, AND it is the switch itself.
      redisSwitch = Boolean(await store.get(KILL_SWITCH));
      registry = "ok";
    } catch {
      registry = "unreachable";
    }
  }

  /**
   * THERE ARE TWO KILL SWITCHES AND THIS ENDPOINT USED TO REPORT ONE.
   *
   * It checked `envKillSwitch()` only. When the bridge was stopped mid-incident
   * with the REDIS switch — the immediate one, the one that needs no redeploy —
   * this endpoint kept answering `healthy: true, killSwitch: "off"` while every
   * request was being refused. A diagnostic that misreports the exact state it
   * exists to report is worse than not having it: it was consulted precisely
   * because something looked wrong, and it said nothing was.
   */
  const envSwitch = envKillSwitch();
  const disabled = envSwitch || redisSwitch;
  const healthy = registry === "ok" && !disabled;

  return Response.json(
    {
      service: "bridger",
      version: "0.1.0",
      healthy,
      registry,
      killSwitch: disabled ? "on" : "off",
      killSwitchSource: disabled ? (redisSwitch ? "redis" : "env") : null,
      limits: { perMinute: RATE_LIMIT_PER_MINUTE, defaultDailyCap: DEFAULT_DAILY_CAP },
      /** The line a partner pastes. Host is derived, so it is right per deploy. */
      mcpEndpoint: "/api/mcp",
    },
    { status: healthy ? 200 : 503 },
  );
}
