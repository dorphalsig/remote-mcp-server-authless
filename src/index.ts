import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  RESULTS_PER_CATEGORY?: string; // text var
  GITHUB_TOKEN?: string;         // secret
}

// --- simple module-scoped context (single-user, minimal) ---
let CURRENT_OWNER = "";
let CURRENT_REPO = "";
let RESULTS_LIMIT = 5;
let GH_HEADERS: Record<string, string> = { Accept: "application/vnd.github+json" };

// Util
const firstLine = (s?: string) => (s || "").split("\n")[0] || "";

// Define our MCP agent with tools (follows your pattern)
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "GitHub Repo Search",
    version: "1.0.0",
  });

  async init() {
    // --- Tool: search ---
    // Args: a single string query
    // Returns: content[ { type:"text", text: JSON.stringify({ results: [{id,title,url}...] }) } ]
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
          fetch(urls.issues, { headers: GH_HEADERS }),
          fetch(urls.prs,    { headers: GH_HEADERS }),
          fetch(urls.commits,{ headers: GH_HEADERS }),
          fetch(urls.code,   { headers: GH_HEADERS }),
        ]);

        const [ji, jp, jc, jcode] = await Promise.all([
          ri.json(), rp.json(), rc.json(), rcode.json(),
        ]);

        const results: Array<{ id: string; title: string; url: string }> = [];

        // Issues (prefix issue:)
        for (const it of ji.items ?? []) {
          results.push({
            id: `issue:${it.number}`,
            title: it.title ?? `Issue #${it.number}`,
            url: it.html_url,
          });
        }

        // PRs (prefix pr:)
        for (const it of jp.items ?? []) {
          results.push({
            id: `pr:${it.number}`,
            title: it.title ?? `PR #${it.number}`,
            url: it.html_url,
          });
        }

        // Commits (prefix commit:)
        for (const it of jc.items ?? []) {
          const sha = it.sha ?? it.hash ?? "";
          const title = firstLine(it.commit?.message) || `Commit ${sha.slice(0, 7)}`;
          results.push({
            id: `commit:${sha}`,
            title,
            url: it.html_url,
          });
        }

        // Code (prefix code:)
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

    // --- Tool: fetch ---
    // Args: a single string ID with a type prefix (issue:/pr:/commit:/code:)
    // Returns: content[ { type:"text", text: JSON.stringify({ id,title,text,url,metadata }) } ]
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
          const j = await r.json();
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
          const j = await r.json();
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
          const j = await r.json();
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
          const j = await r.json();
          let text = "";
          if (j?.content && j?.encoding === "base64") {
            text = atob(String(j.content).replace(/\n/g, ""));
          }
          doc = {
            id,
            title: `blob ${sha}`,
            text,
            url: u, // API URL; no canonical html for raw blob SHA
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

// --- Worker entry that mirrors your example, but under /:owner/:repo/ ---
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["owner","repo","sse"] or ["owner","repo","sse","message"]

    // Only accept /:owner/:repo/(sse|sse/message|mcp)
    const isRepoScoped =
      (parts.length === 3 && (parts[2] === "sse" || parts[2] === "mcp")) ||
      (parts.length === 4 && parts[2] === "sse" && parts[3] === "message");

    if (!isRepoScoped) {
      return new Response("Not found", { status: 404 });
    }

    // --- set the per-request repo + env (simple single-user globals) ---
    CURRENT_OWNER = parts[0];
    CURRENT_REPO = parts[1];

    // env -> limit + token headers; log what we read
    const rawLimit = env.RESULTS_PER_CATEGORY ?? "5";
    const n = Number.parseInt(rawLimit, 10);
    RESULTS_LIMIT = Number.isFinite(n) && n > 0 ? n : 5;

    // reset headers each request
    GH_HEADERS = { Accept: "application/vnd.github+json" };
    if (env.GITHUB_TOKEN) GH_HEADERS.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

    console.log("[MCP] owner/repo:", `${CURRENT_OWNER}/${CURRENT_REPO}`);
    console.log("[MCP] RESULTS_PER_CATEGORY:", RESULTS_LIMIT);
    console.log("[MCP] GITHUB_TOKEN present:", Boolean(env.GITHUB_TOKEN));

    // --- route exactly like your example, but with dynamic prefix ---
    const prefix = `/${CURRENT_OWNER}/${CURRENT_REPO}`;
    if (
      url.pathname === `${prefix}/sse` ||
      url.pathname === `${prefix}/sse/message`
    ) {
      // @ts-ignore — method provided by Cloudflare Agents SDK
      return MyMCP.serveSSE(`${prefix}/sse`).fetch(request, env, ctx);
    }

    if (url.pathname === `${prefix}/mcp`) {
      // @ts-ignore — method provided by Cloudflare Agents SDK
      return MyMCP.serve(`${prefix}/mcp`).fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
