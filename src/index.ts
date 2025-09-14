import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = { GITHUB_TOKEN?: string };
type State = {
  index: Record<string, { owner: string; repo: string; path: string; sha?: string; html_url: string }>;
};
type Props = { owner: string; repo: string };

class GitHubRepoAdapter extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "github-repo-adapter", version: "1.0.0" });
  initialState: State = { index: {} };

  async init() {
    // ---- search (repo-scoped from URL) ----
    this.server.tool(
      "search",
      "Searches code in the bound GitHub repo; returns IDs usable by fetch().",
      {
        query: z.string().describe("Search terms"),
        path: z.string().optional(),
        language: z.string().optional(),
        filename: z.string().optional(),
        extension: z.string().optional(),
        subset: z.enum(["code", "docs"]).optional().default("code"),
        per_page: z.number().int().min(1).max(50).optional().default(10),
        page: z.number().int().min(1).max(10).optional().default(1),
      },
      async (args, _toolCtx, env) => {
        const { owner, repo } = this.props;
        const { query, path, language, filename, extension, subset, per_page, page } = args;

        const quals = [`repo:${owner}/${repo}`, "in:file"];
        if (path)      quals.push(`path:${path}`);
        if (language)  quals.push(`language:${language}`);
        if (filename)  quals.push(`filename:${filename}`);
        if (extension) quals.push(`extension:${extension}`);
        if (subset === "docs") quals.push("path:docs", "filename:README", "extension:md");

        const q = encodeURIComponent([query, ...quals].join(" "));
        const url = `https://api.github.com/search/code?q=${q}&per_page=${per_page}&page=${page}`;

        // Ask for text match snippets
        const headers: Record<string, string> = {
          "Accept": "application/vnd.github.text-match+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error(`GitHub search failed: ${r.status} ${r.statusText}`);
        const data = await r.json();

        const results = (data.items ?? []).map((it: any) => {
          const id = it.sha as string;
          this.state.index[id] = {
            owner, repo, path: it.path, sha: it.sha, html_url: it.html_url,
          };
          return {
            id,
            title: `${it.repository.full_name}/${it.path}`,
            url: it.html_url,
            path: it.path,
            snippet: it.text_matches?.[0]?.fragment,
          };
        });

        return { content: [{ type: "json", json: { results } }] };
      }
    );

    // ---- fetch (by ids from search, or explicit path) ----
    this.server.tool(
      "fetch",
      "Fetches file content by IDs from search() or by explicit path.",
      {
        ids: z.array(z.string()).optional(),
        path: z.string().optional(),
        ref: z.string().optional().default("HEAD"),
      },
      async (args, _toolCtx, env) => {
        const { owner, repo } = this.props;
        const baseHeaders: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28" };
        if (env.GITHUB_TOKEN) baseHeaders.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

        const out: Array<{ path: string; source_url: string; content: string }> = [];

        // A) by IDs → Git Blobs API (raw)
        if (args.ids?.length) {
          for (const id of args.ids) {
            const meta = this.state.index[id];
            if (!meta) continue;
            const blobUrl = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${meta.sha}`;
            const rh = { ...baseHeaders, Accept: "application/vnd.github.raw+json" };
            const rr = await fetch(blobUrl, { headers: rh });
            if (!rr.ok) throw new Error(`Blob fetch failed: ${rr.status} ${rr.statusText}`);
            const content = await rr.text();
            out.push({ path: meta.path, source_url: meta.html_url, content });
          }
        }

        // B) explicit path → Contents API (raw)
        if (args.path) {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(args.path)}?ref=${encodeURIComponent(args.ref!)}`;
          const rh = { ...baseHeaders, Accept: "application/vnd.github.raw+json" };
          const rr = await fetch(url, { headers: rh });
          if (!rr.ok) throw new Error(`Contents fetch failed: ${rr.status} ${rr.statusText}`);
          const content = await rr.text();
          out.push({
            path: args.path,
            source_url: `https://github.com/${owner}/${repo}/blob/${args.ref}/${args.path}`,
            content,
          });
        }

        return { content: [{ type: "json", json: { files: out } }] };
      }
    );
  }
}

// ---- Router: /<owner>/<repo>/sse (SSE) and /<owner>/<repo>/mcp (Streamable HTTP) ----
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/(sse|mcp)(?:\/.*)?$/);
    if (!m) return new Response("Not found. Use /<owner>/<repo>/(sse|mcp)", { status: 404 });

    const [, owner, repo, mode] = m;
    const base = `/${owner}/${repo}/${mode}`;

    // Pass owner/repo to the agent instance via ctx.props so tools can read this.props
    (ctx as any).props = { owner, repo };

    return mode === "sse"
      ? GitHubRepoAdapter.serveSSE(base).fetch(request, env, ctx)
      : GitHubRepoAdapter.serve(base).fetch(request, env, ctx);
  },
};
