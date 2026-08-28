import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

import { joinAcceptIsHtml } from "../invites";
import { TOKEN_PREFIX } from "../room-registry";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const toolsSrc = readFileSync(join(root, "public/j-tools.js"), "utf8");
const routeSrc = readFileSync(join(root, "app/j/[code]/route.ts"), "utf8");

const TOOL_NAMES = ["join_or_status", "read", "wait", "ask", "answer", "decide"];

describe("WebMCP on HTML /j — Challenge surface, not the home", () => {
  it("Accept-split is unchanged: HTML does not redeem", () => {
    assert.equal(joinAcceptIsHtml("text/html"), true);
    assert.equal(joinAcceptIsHtml("text/plain"), false);
    const getFn = routeSrc.slice(routeSrc.indexOf("export async function GET"));
    assert.ok(
      getFn.indexOf("if (joinAcceptIsHtml") < getFn.indexOf("await redeemInvite"),
      "HTML path must be decided before redeemInvite",
    );
    assert.match(routeSrc, /<script src="\/j-tools\.js">/);
    assert.doesNotMatch(routeSrc, /<textarea/i);
    assert.doesNotMatch(toolsSrc, /<textarea/i);
  });

  it("registerTool exists in source and is feature-detected", () => {
    assert.match(toolsSrc, /document\.modelContext\?\.registerTool/);
    assert.match(toolsSrc, /typeof document\.modelContext\.registerTool !== "function"/);
    for (const name of TOOL_NAMES) {
      assert.match(toolsSrc, new RegExp('"' + name + '"'));
    }
    const answerBlock = toolsSrc.slice(toolsSrc.indexOf('"answer"'), toolsSrc.indexOf('"decide"'));
    assert.match(answerBlock, /required:\s*\[[^\]]*checkedAgainst/);
  });

  it("does not crash when document.modelContext is missing", async () => {
    const sandbox = createContext({
      document: {},
      location: { href: "https://bridge.example/j/7KMP-3QRV-9XZT" },
      fetch: async () => {
        throw new Error("fetch must not run without WebMCP");
      },
      AbortController,
    });
    runInContext(toolsSrc, sandbox);
    await runInContext("__bridgerWebmcpReady", sandbox);
  });

  it("registers the small tool set and wraps redeem + /api/rpc after opt-in", async () => {
    const token = TOKEN_PREFIX + "x".repeat(24);
    const fetches: { url: string; init?: RequestInit }[] = [];
    const registered: { name: string; schema: unknown; execute: Function; opts: unknown }[] = [];

    const sandbox = createContext({
      document: {
        modelContext: {
          registerTool: async (tool: { name: string; inputSchema: unknown; execute: Function }, opts: unknown) => {
            registered.push({ name: tool.name, schema: tool.inputSchema, execute: tool.execute, opts });
          },
        },
      },
      location: { href: "https://bridge.example/j/7KMP-3QRV-9XZT" },
      fetch: async (url: string, init?: RequestInit) => {
        fetches.push({ url, init });
        const href = String(url);
        if (href.includes("/j/")) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const accept = String(headers.Accept ?? "");
          assert.equal(accept.includes("text/html"), false, "redeem fetch must not send HTML Accept");
          return {
            text: async () =>
              "YOU ARE NOW ON A BRIDGER BRIDGE.\n  Your token   : " + token + "\n  Endpoint     : POST https://bridge.example/api/rpc\n",
          };
        }
        if (href.includes("/api/rpc")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return { text: async () => JSON.stringify({ ok: true, op: body.op }) };
        }
        throw new Error("unexpected fetch " + href);
      },
      AbortController,
    });
    runInContext(toolsSrc, sandbox);
    await runInContext("__bridgerWebmcpReady", sandbox);

    assert.deepEqual(
      registered.map((t) => t.name),
      TOOL_NAMES,
    );
    assert.ok(registered.every((t) => t.opts && (t.opts as { signal: AbortSignal }).signal instanceof AbortSignal));

    const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

    const beforeJoin = await byName.read.execute({ since: 0, markRead: true }, { signal: undefined });
    assert.match(String(beforeJoin), /join_or_status/);
    assert.equal(fetches.length, 0, "other tools must not redeem until opt-in");

    const status = await byName.join_or_status.execute({}, { signal: undefined });
    assert.match(String(status), /"op":"status"/);
    assert.equal(fetches[0].url, "https://bridge.example/j/7KMP-3QRV-9XZT");
    assert.equal(fetches[1].url, "/api/rpc");
    const auth = (fetches[1].init?.headers as Record<string, string>).Authorization;
    assert.equal(auth, "Bearer " + token);
    assert.doesNotMatch(String(status), new RegExp(token));

    const answered = await byName.answer.execute(
      { questionId: "XXX-Q-001", answer: "yes", checkedAgainst: "file.ts:41" },
      {},
    );
    assert.match(String(answered), /"op":"answer"/);

    const refused = await byName.answer.execute({ questionId: "XXX-Q-001", answer: "yes" }, {});
    assert.match(String(refused), /checkedAgainst is required/);
  });
});
