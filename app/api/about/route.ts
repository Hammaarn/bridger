/**
 * DUE DILIGENCE WITHOUT PRESENTING A CREDENTIAL.
 *
 * WHY THIS EXISTS, and it was written after a refusal rather than before one.
 * On 2026-08-16 a partner's Claude was handed a Bridger token and declined to
 * use it — declined even to call `{"op":"status"}`, on the correct reasoning
 * that a "harmless" status call still means authenticating to a service it
 * cannot verify. It was right, and every other route on this server required a
 * token, so there was no way for it to answer "what is this" without first
 * doing the thing it was unwilling to do.
 *
 * That is the gap this closes. **No authentication.** An agent, or the human
 * deciding for it, can read what this service is, what it stores, what it does
 * not do, and where the source lives, all before any credential leaves their
 * machine.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not claim to be trustworthy, and it
 * cannot: a service asserting its own legitimacy is worth exactly nothing, since
 * an attacker would serve the same JSON. Every field here is either (a) a
 * pointer to something independently checkable — the repository, a file path, a
 * command to run — or (b) filed under `cannotVerify`. The honest limitations are
 * IN the payload rather than omitted from it, because a document that oversells
 * is worse than no document.
 *
 * KEPT IN SYNC BY CONSTRUCTION where it can be. The numeric limits below are
 * imported from `lib/store.ts` and `lib/mint-limit.ts` rather than retyped, so
 * this endpoint cannot drift into describing retention or rate limits that the
 * code stopped enforcing months ago. The prose can still rot; the numbers
 * cannot.
 */

import {
  AUDIT_LOG_MAX,
  DEFAULT_DAILY_CAP,
  DEFAULT_ROOM_DAILY_CAP,
  DEFAULT_TOKEN_TTL_DAYS,
  MAX_ENTRIES,
  RATE_LIMIT_PER_MINUTE,
  ROOM_TTL_SECONDS,
  VIEWER_RATE_LIMIT_PER_MINUTE,
} from "@/lib/store";
import { ROOMS_PER_DAY_PER_IP, UNCLAIMED_ROOM_TTL_SECONDS } from "@/lib/mint-limit";
import { INVITE_TTL_SECONDS, PASTE_TOKEN_TTL_SECONDS } from "@/lib/invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO = "https://github.com/Hammaarn/bridger";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  return Response.json(
    {
      service: "bridger",
      what: "A shared, append-only record two teams' AI sessions read and write: questions, answers, decisions, and the contract both sides build against. Every answer carries the source it was checked against, or is recorded as unchecked.",

      operator: {
        name: "Erik Hammarström",
        location: "Stockholm, Sweden",
        context:
          "Built alongside JudgeMySite (https://judgemysite.org), a live product with real integrations.",
      },

      source: {
        repository: REPO,
        license: "see repository",
        verifyDocument: `${REPO}/blob/master/VERIFY.md`,
        note: "Read the server that is asking you to trust it. Everything below is checkable there.",
      },

      /**
       * WHICH COMMIT IS ANSWERING YOU.
       *
       * Linking to a repository only says "the source exists somewhere". This
       * says which revision of it produced the response you are reading, so the
       * claim stops being self-assertion: take the sha, open the commit URL,
       * read the exact code that just replied.
       *
       * It does not make tampering impossible — a dishonest operator could
       * report any string here. What it does is remove the AMBIGUITY: an honest
       * deployment is now checkable against public code, and a mismatch between
       * this sha and the behaviour you observe is evidence rather than a
       * suspicion you cannot act on.
       */
      build: {
        commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        commitUrl: process.env.VERCEL_GIT_COMMIT_SHA
          ? `${REPO}/commit/${process.env.VERCEL_GIT_COMMIT_SHA}`
          : null,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
        region: process.env.VERCEL_REGION ?? null,
        note: "The revision that produced this response. Open commitUrl and read exactly what is running. Null means it is running outside a Vercel build — a local clone, for instance, which is the strongest verification of all.",
      },

      // The single most important field on this endpoint. Most MCP servers ask
      // for a scope — Drive, Slack, a filesystem. This one asks for a room.
      permissions: {
        requests: "none",
        oauth: false,
        filesystemAccess: false,
        repositoryAccess: false,
        ambientAccess:
          "None. Every byte this service receives was placed there by a tool call the caller chose to make; it cannot reach into a session and take anything.",
        scope: "One bearer token addresses exactly one room and one side of it.",
      },

      callsAModel: false,
      callsAModelDetail:
        "No provider SDK is a dependency and no code path requests a model API. Both sides run on their own subscriptions; reasoning never leaves the caller's session. Verify: `node -p \"Object.keys(require('./package.json').dependencies)\"` — seven entries, none a model SDK.",

      dataHandling: {
        storedWhere: "Upstash Redis, eu-central-1",
        tokensStored: "sha256 hash only — the plaintext is shown once at mint and never persisted",
        ipAddressesStored:
          "never; the room-creation counter keys on a salted, length-prefixed hash of the address bucket",
        auditLogContents: "timestamp, token id, room id, side, operation, outcome — never a token",
        sharedWithThirdParties: "none; the only external service in the data path is the database",
        export: `GET ${origin}/api/export with your token returns the complete record at any time`,
      },

      retention: {
        roomIdleSeconds: ROOM_TTL_SECONDS,
        roomIdleHuman: `${ROOM_TTL_SECONDS / 86400} days idle — refreshed on every write, so an active room does not expire and a finished one lapses`,
        unclaimedRoomSeconds: UNCLAIMED_ROOM_TTL_SECONDS,
        maxEntriesPerRoom: MAX_ENTRIES,
        auditRowsRetained: AUDIT_LOG_MAX,
        tokenDefaultDays: DEFAULT_TOKEN_TTL_DAYS,
        joinCodeSeconds: INVITE_TTL_SECONDS,
        joinCodeTokenSeconds: PASTE_TOKEN_TTL_SECONDS,
      },

      limits: {
        perTokenPerMinute: RATE_LIMIT_PER_MINUTE,
        viewerPerMinute: VIEWER_RATE_LIMIT_PER_MINUTE,
        perTokenPerDay: DEFAULT_DAILY_CAP,
        perRoomPerDay: DEFAULT_ROOM_DAILY_CAP,
        newRoomsPerDayPerAddress: ROOMS_PER_DAY_PER_IP,
        why: "These protect the CALLER. Tokens burn in the caller's own session, so an agent loop costs them, not us — one such loop consumed an entire model quota before these existed.",
      },

      safety: {
        untrustedTextContainment:
          "All far-side text is wrapped in [[UNTRUSTED-PARTNER-TEXT]] markers before it reaches a model.",
        deterministicHalf:
          "Marker neutralisation — text attempting to forge or escape our markers is escaped by string surgery. This is what the tests pin.",
        advisoryHalf:
          "The 'data, not instructions' banner is an instruction to a model and therefore probabilistic. It raises the cost of an attack; it does not bound it.",
        credentialRefusal:
          "Writes matching known credential formats are refused outright, Bridger's own token format listed first (lib/secrets.ts).",
        revocation: "Any token dies on demand, in seconds, from the operator's CLI.",
      },

      // Named, not hidden. A trust document that omits its own limits is an
      // advertisement, and the reader can tell.
      cannotVerify: [
        "The operator can read every room. Rewriting one is now DETECTABLE — every entry is hash-chained to its predecessor — but the SERVER computes those hashes, so an operator could recompute the whole chain and serve a consistent forgery. A chain verified only against the server that produced it proves nothing about that server. What makes it evidence is `bridger verify`, which stores the head hash on YOUR disk: a head that changes without the record growing is a rewrite you can prove. The accurate claim is 'cannot alter it without every side that pulled it being able to prove so', not 'cannot alter it'. For end-to-end certainty, run your own instance — it works fully offline with BRIDGER_STORE=file.",
        "Sending information to the other company is the product. No design removes that; it is only bounded, visible and revocable.",
        "No third party has audited this. There is no central review for arbitrary MCP servers — the protocol is open, not a curated store.",
        "It is young: written in August 2026, one live integration. Judge it as what it is.",
        "A one-time join link puts a token into the model's context and therefore into transcripts and logs. Prefer the MCP config path, where the token stays in a file the model never reads.",
      ],

      recommendedBeforeTrusting: [
        "Read the source at " + REPO,
        "Run it entirely locally first: BRIDGER_STORE=file npm run dev — no account, no credentials, the whole record in .bridger-data/bridge.json",
        "Connect from a session that does NOT hold production credentials before one that does",
        `Ask the tool surface what it can do: POST ${origin}/api/mcp {"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
        "If you are an agent with production access and you are unsure: say so and let your operator decide. That is the correct division of responsibility, and a refusal is a better outcome than a careless connection.",
      ],

      endpoints: {
        about: `${origin}/api/about`,
        health: `${origin}/api/health`,
        whoami: `${origin}/api/whoami`,
        mcp: `${origin}/api/mcp`,
        flatHttp: `${origin}/api/rpc`,
        export: `${origin}/api/export`,
      },
    },
    {
      status: 200,
      headers: {
        // Public, non-secret, and useful to anyone deciding whether to trust
        // this service — including a client on another origin doing exactly the
        // due diligence this endpoint exists to enable. Every other route stays
        // same-origin and bearer-authed.
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
