import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Cloudflare Worker Remote MCP server exposing ONLY ChatGPT-connector compatible tools:
 *   - search({ query: string })
 *   - fetch({ ids: string[] })
 *
 * Route shape (repo-scoped): /<owner>/<repo>/(sse|mcp)
 *
 * Auth: optional GITHUB_TOKEN (fine‑grained PAT, read‑only) set as a Worker secret.
 * This implementation calls GitHub's REST API directly (NOT gitmcp.io).
 */

type Env = { GITHUB_TOKEN?: string };

type State = {
  index: Record<string, { owner: string; repo: string; path: string; sha?: string; html_url: string }>;
};

type Props = { owner: string; repo: string };

const GH_API = "https://api.github.com";

function ghHeaders(env: Env, accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-github-repo-adapter/1.3 (+cloudflare-workers)",
  };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function ghJson<T>(env: Env, url: string, accept?: string): Promise<T> {
  const r = await fetch(url, { headers: ghHeaders(env, accept) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GitHub API ${r.status} ${r.statusText} for ${url}${body ? `
${body}` : ""}`);
  }
  return (await r.json()) as T;
}

async function ghText(env: Env, url: string, accept: string): Promise<string> {
  const r = await fetch(url, { headers: ghHeaders(env, accept) });
  if (!r.ok) throw new Error(`GitHub API ${r.status} ${r.statusText} for ${url}`);
  return await r.text();
}

export class MyMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "github-repo-adapter", version: "1.3.0" });
  initialState: State = { index: {} };

  async init() {
    // -------- search({ query }) --------
    this.server.tool(
      {
        name: "search",
        description: "Search code in this repo and return IDs usable by fetch(). Argument: { query: string }.",
        inputSchema: z.object({
          query: z
            .string()
            .describe("Query string; include GitHub qualifiers like path:src language:ts as needed."),
        }),
      },
      async ({ query }) => {
        const { owner, repo } = this.props;
        const qstr = encodeURIComponent([query, `repo:${owner}/${repo}`, "in:file"].join(" "));
        const url = `${GH_API}/search/code?q=${qstr}`;
        const data = await ghJson<any>(this.env, url, "application/vnd.github.text-match+json");
        const results = (data.items ?? []).map((it: any) => {
          const id = String(it.sha);
          this.state.index[id] = { owner, repo, path: it.path, sha: it.sha, html_url: it.html_url };
          return {
            id,
            title: `${it.repository?.full_name ?? `${owner}/${repo}`}/${it.path}`,
            url: it.html_url,
            path: it.path,
            snippet: it.text_matches?.[0]?.fragment,
          };
        });
        return { content: [{ type: "json", json: { results } }] };
      }
    );

    // -------- fetch({ ids }) --------
    this.server.tool(
      {
        name: "fetch",
        description:
          "Fetch file contents for a list of IDs or paths returned by search(). Argument: { ids: string[] }.",
        inputSchema: z.object({
          ids: z
            .array(z.string())
            .min(1)
            .describe(
              "IDs returned by search (blob SHAs). If a value isn't a known ID, it's treated as a repo-relative path."
            ),
        }),
      },
      async ({ ids }) => {
        const { owner, repo } = this.props;
        const out: Array<{ path: string; source_url: string; content: string }> = [];
        for (const token of ids) {
          const meta = this.state.index[token];
          if (meta?.sha) {
            // blob by SHA
            const blobUrl = `${GH_API}/repos/${owner}/${repo}/git/blobs/${meta.sha}`;
            const content = await ghText(this.env, blobUrl, "application/vnd.github.raw+json");
            out.push({ path: meta.path, source_url: meta.html_url, content });
          } else {
            // treat as path at HEAD
            const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(token)}?ref=HEAD`;
            const content = await ghText(this.env, url, "application/vnd.github.raw+json");
            out.push({ path: token, source_url: `https://github.com/${owner}/${repo}/blob/HEAD/${token}`, content });
          }
        }
        return { content: [{ type: "json", json: { files: out } }] };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/(sse|mcp)(?:\/.*)?$/);
    if (!m) return new Response("Not found. Use /<owner>/<repo>/(sse|mcp)", { status: 404 });
    const [, ownerEnc, repoEnc, mode] = m;
    const owner = decodeURIComponent(ownerEnc);
    const repo = decodeURIComponent(repoEnc);

    (ctx as any).props = { owner, repo } as Props;
    const base = `/${owner}/${repo}/${mode}`;

    return mode === "sse"
      ? MyMCP.serveSSE(base).fetch(request, env, ctx)
      : MyMCP.serve(base).fetch(request, env, ctx);
  },
};
