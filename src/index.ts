import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  RESULTS_PER_CATEGORY?: string; // text var (default "5")
  GITHUB_TOKEN?: string;         // secret
}

/** ---------- tiny helpers ---------- **/
const firstLine = (s?: string) => (s || "").split("\n")[0] || "";

async function safeJson<T = any>(res: Response): Promise<T | null> {
  const txt = await res.text();
  try { return JSON.parse(txt) as T; }
  catch {
    console.warn("[GitHub] Non-JSON response", res.status, txt.slice(0, 200));
    return null;
  }
}

function ownerRepoFromPath(pathname: string): { owner: string; repo: string } | null {
  // expect: /:owner/:repo/sse, /:owner/:repo/sse/message, or /:owner/:repo/mcp
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && (parts[2] === "sse" || parts[2] === "mcp")) {
    return { owner: parts[0], repo: parts[1] };
  }
  if (parts.length >= 4 && parts[2] === "sse" && parts[3] === "message") {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

/** ---------- per-request state (simple & single-user) ---------- **/
let CURRENT_OWNER = "";
let CURRENT_REPO = "";
let RESULTS_LIMIT = 5;
let GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28", // recommended by GitHub
  "User-Agent": "mcp-worker",           // GitHub requires a User-Agent
};

/** ---------- MCP Agent using your exact template shape ---------- **/
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "GitHub Repo Search",
    version: "1.0.0",
  });

  async init() {
    /** --------- search tool ---------
     * Args: (string) query
     * Returns: content: [{ type: "text", text: JSON.stringify({ results: [{id,title,url}...] }) }]
     * Searches PRs, issues, commits, and code within repo from the URL.
     */
    this.server.tool(
      "search",
      z.string().describe("Query string to search within the repository"),
      async (query: string) => {
        const owner = CURRENT_OWNER;
        const repo = CURRENT_REPO;
        const perPage = RESULTS_LIMIT;

        const base = "https://api.github.com/search";
        const q = encodeURIComponent(query);

        const urls = {
          issues: `${base}/issues?q=repo:${owner}/${repo}+is:issue+${q}&per_page=${perPage}`,
          prs:    `${base}/issues?q=repo:${owner}/${repo}+is:pr+${q}&per_page=${perPage}`,
          commits:`${base}/commits?q=repo:${owner}/${repo}+${q}&per_page=${perPage}`,
          code:   `${base}/code?q=repo:${owner}/${repo}+${q}&per_page=${perPage}`,
        };

        const [ri, rp, rc, rcode] = await Promise.all([
          fetch(urls.issues,  { headers: GH_HEADERS }),
          fetch(urls.prs,     { headers: GH_HEADERS }),
          fetch(urls.commits, { headers: GH_HEADERS }),
          fetch(urls.code,    { headers: GH_HEADERS }),
        ]);

        const ji = (await safeJson<any>(ri))    ?? { items: [] };
        const jp = (await safeJson<any>(rp))    ?? { items: [] };
        const jc = (await safeJson<any>(rc))    ?? { items: [] };
        const jcode = (await safeJson<any>(rcode)) ?? { items: [] };

        const results: Array<{ id: string; title: string; url: string }> = [];

        // Issues (prefix: issue:)
        for (const it of ji.items ?? []) {
          results.push({
            id: `issue:${it.number}`,
            title: it.title ?? `Issue #${it.number}`,
            url: it.html_url,
          });
        }

        // PRs (prefix: pr:)
        for (const it of jp.items ?? []) {
          results.push({
            id: `pr:${it.number}`,
            title: it.title ?? `PR #${it.number}`,
            url: it.html_url,
          });
        }

        // Commits (prefix: commit:)
        for (const it of jc.items ?? []) {
          const sha = it.sha ?? it.hash ?? "";
          const title = firstLine(it.commit?.message) || `Commit ${sha.slice(0, 7)}`;
          results.push({
            id: `commit:${sha}`,
            title,
            url: it.html_url,
          });
        }

        // Code (prefix: code:)
        for (const it of jcode.items ?? []) {
          const sha = it.sha ?? "";
          const path = it.path ?? it.name ?? sha;
          results.push({
            id: `code:${sha}`,
            title: path,
            url: it.html_url,
          });
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ results }) }],
        };
      }
    );

    /** --------- fetch tool ---------
     * Args: (string) id with type prefix (issue:N | pr:N | commit:SHA | code:SHA)
     * Returns: content: [{ type: "text", text: JSON.stringify({ id,title,text,url,metadata }) }]
     */
    this.server.tool(
      "fetch",
      z.string().describe("Prefixed ID from `search`: issue:<n> | pr:<n> | commit:<sha> | code:<sha>"),
      async (id: string) => {
        const owner = CURRENT_OWNER;
        const repo = CURRENT_REPO;

        const [prefix, rest] = id.split(":");
        let doc: {
          id: string;
          title: string;
          text: string;
          url: string;
          metadata?: Record<string, unknown>;
        };

        if (prefix === "issue") {
          const u = `https://api.github.com/repos/${owner}/${repo}/issues/${rest}`;
          const r = await fetch(u, { headers: GH_HEADERS });
          const j = (await safeJson<any>(r)) ?? {};
          doc = {
            id,
            title: j.title ?? `Issue #${rest}`,
            text: j.body ?? "",
            url: j.html_url ?? u,
            metadata: { state: j.state, labels: j.labels, number: j.number },
          };
        } else if (prefix === "pr") {
          const u = `https://api.github.com/repos/${owner}/${repo}/pulls/${rest}`;
          const r = await fetch(u, { headers: GH_HEADERS });
          const j = (await safeJson<any>(r)) ?? {};
          doc = {
            id,
            title: j.title ?? `PR #${rest}`,
            text: j.body ?? "",
            url: j.html_url ?? u,
            metadata: {
              state: j.state,
              merged: j.merged,
              head: j.head,
              base: j.base,
              number: j.number,
            },
          };
        } else if (prefix === "commit") {
          const sha = rest;
          const u = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;
          const r = await fetch(u, { headers: GH_HEADERS });
          const j = (await safeJson<any>(r)) ?? {};
          const message: string = j?.commit?.message ?? "";
          const title = firstLine(message) || `Commit ${sha.slice(0, 7)}`;
          doc = {
            id,
            title,
            text: message,
            url: j.html_url ?? u,
            metadata: { author: j.commit?.author, committer: j.commit?.committer, sha },
          };
        } else if (prefix === "code") {
          const sha = rest;
          const u = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`;
          const r = await fetch(u, { headers: GH_HEADERS });
          const j = (await safeJson<any>(r)) ?? {};
          let text = "";
          if (j?.content && j?.encoding === "base64") {
            text = atob(String(j.content).replace(/\n/g, ""));
          }
          doc = {
            id,
            title: `blob ${sha}`,
            text,
            url: u, // API URL; blobs by SHA don't have a canonical html_url
            metadata: { size: j.size, encoding: j.encoding, sha },
          };
        } else {
          doc = {
            id,
            title: "Unknown ID prefix",
            text: "Use one of: issue, pr, commit, code",
            url: "",
            metadata: {},
          };
        }

        return { content: [{ type: "text", text: JSON.stringify(doc) }] };
      }
    );
  }
}

/** ---------- Worker entry that mirrors your example, but under /:owner/:repo/ ---------- **/
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const params = ownerRepoFromPath(url.pathname);

    // Only accept /:owner/:repo/(sse|sse/message|mcp); else 404
    if (!params) {
      return new Response("Not found", { status: 404 });
    }

    // set per-request repo + env
    CURRENT_OWNER = params.owner;
    CURRENT_REPO = params.repo;

    const rawLimit = env.RESULTS_PER_CATEGORY ?? "5";
    const parsed = Number.parseInt(rawLimit, 10);
    RESULTS_LIMIT = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;

    GH_HEADERS = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-worker",
    };
    if (env.GITHUB_TOKEN) GH_HEADERS.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

    // log env values read (no secrets leaked)
    console.log("[MCP] owner/repo:", `${CURRENT_OWNER}/${CURRENT_REPO}`);
    console.log("[MCP] RESULTS_PER_CATEGORY:", RESULTS_LIMIT);
    console.log("[MCP] GITHUB_TOKEN present:", Boolean(env.GITHUB_TOKEN));

    const prefix = `/${CURRENT_OWNER}/${CURRENT_REPO}`;

    if (url.pathname === `${prefix}/sse` || url.pathname === `${prefix}/sse/message`) {
      // Serve SSE per your template
      // @ts-ignore method provided by the Cloudflare Agents SDK
      return MyMCP.serveSSE(`${prefix}/sse`).fetch(request, env, ctx);
    }

    if (url.pathname === `${prefix}/mcp`) {
      // Optional RPC endpoint per your template
      // @ts-ignore method provided by the Cloudflare Agents SDK
      return MyMCP.serve(`${prefix}/mcp`).fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
