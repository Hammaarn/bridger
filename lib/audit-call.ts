/**
 * Name a JSON-RPC call for the audit row, without disturbing it.
 *
 * Lives in `lib/` rather than beside the handler for one reason: it has real
 * branching — POST vs stream lifecycle, batch vs single, `tools/call` vs every
 * other method, and a body that will not parse — and branching that only exists
 * inside a route module is branching nothing can check. The route imports it.
 */

/**
 * Reads a CLONE of the body. The original is still unread when the request
 * reaches the MCP handler, which is the only reason this can sit in front of it.
 *
 * Never throws. It is called on the logging path, and a logger that can fail a
 * request is worse than a missing log line.
 */
export async function describeCall(req: Request): Promise<string> {
  // GET and DELETE are the SSE stream's lifecycle, not tool calls.
  if (req.method !== "POST") return req.method.toLowerCase();
  try {
    const body: unknown = await req.clone().json();
    return (Array.isArray(body) ? body.map(nameOne).join(",") : nameOne(body)).slice(0, 120);
  } catch {
    // A body we cannot parse is still a call that happened. "unparsed" beats
    // logging nothing, and beats throwing inside the logger.
    return "unparsed";
  }
}

function nameOne(message: unknown): string {
  const r = (message ?? {}) as { method?: unknown; params?: { name?: unknown } };
  const method = typeof r.method === "string" ? r.method : "unknown";
  const name = typeof r.params?.name === "string" ? r.params.name : null;
  // `tools/call` is the only method whose name is worth more than its verb:
  // "who called bridger_ask how often" is the question, not "how many
  // tools/call requests were there".
  return method === "tools/call" && name ? name : method;
}
