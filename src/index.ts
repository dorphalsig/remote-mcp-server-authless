// src/index.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// --- Configure your default repo here (you can also pass owner/repo in the call) ---
const DEFAULT_OWNER = "UltraStar-Deluxe";
const DEFAULT_REPO  = "USDX";

// Optional: set a GitHub token in CF Dashboard → Workers → Variables → GITHUB_TOKEN
type Env = { GITHUB_TOKEN?: string };
type State = {
  // simple in-session index so fetch(ids) works
  index: Record<string, { owner: string; repo: string; path: string; sha?: string; html_url: string }>;
};
type Props = {};

export class GitHubAdapter extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "github-repo-adapter", version: "1.0.0" });
  initialState: State = { index: {} };

  async init() {
    // --- Tool: search ---
    this.server.tool(
      "search",
      // Tip: keep names 'search' and 'fetch' exactly for ChatGPT compatibility
      "Search a specific GitHub repo; returns IDs usable with fetch(ids).",
      {
        query: z.string().describe("Search query string"),
        owner: z.string().optional().default(DEFAULT_OWNER),
        repo: z.string().optional().default(DEFAULT_REPO),
        subset: z.enum(["code", "docs"]).optional().default("code"),
        path: z.string().optional(),
        language: z.string().optional(),
        filename: z.string().optional(),
        extension: z.string().optional(),
        per_page: z.number().int().min(1).max(50).optional().default(10),
        page: z.number().int().min(1).max(10).optional().default(1),
      },
      async (args, _toolCtx, env) => {
        const {
          query, owner = DEFAULT_OWNER, repo = DEFAULT_REPO, subset,
          path, language, filename, extension, per_page, page,
        } = args;

        const quals = [`repo:${owner}/${repo}`, "in:file"];
        if (path)      quals.push(`path:${path}`);
        if (language)  quals.push(`language:${language}`);
        if (filename)  quals.push(`filename:${filename}`);
        if (extension) quals.push(`extension:${extension}`);

        // Light doc bias if subset === 'docs'
        if (subset === "docs") {
          // nudge toward docs without overconstraining
          quals.push("path:docs", "filename:README", "extension:md");
        }

        const q = encodeURIComponent([query, ...quals].join(" "));
        const url = `https://api.github.com/search/code?q=${q}&per_page=${per_page}&page=${page}`;

        const headers: Record<string, string> = {
          // include text matches/snippets
          "Accept": "application/vnd.github.text-match+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error(`GitHub search failed: ${r.status} ${r.statusText}`);
        const data = await r.json();

        const results = (data.items ?? []).map((it: any) => {
          const id = it.sha as string; // stable blob SHA for fetch(ids)
          // remember mapping for this session so fetch(ids) can deref
          this.state.index[id] = {
            owner, repo, path: it.path, sha: it.sha, html_url: it.html_url,
          };
          return {
            id,
            title: `${it.repository.full_name}/${it.path}`,
            url: it.html_url,
            path: it.path,
            repo: it.repository.full_name,
            snippet: it.text_matches?.[0]?.fragment,
          };
        });

        return {
          content: [{ type: "json", json: { results } }],
        };
      }
    );

    // --- Tool: fetch ---
    this.server.tool(
      "fetch",
      "Fetch file content by IDs returned from search, or by explicit path.",
      {
        ids: z.array(z.string()).optional().describe("IDs from search(). Use this OR (owner,repo,path)."),
        owner: z.string().optional(),
        repo: z.string().optional(),
        path: z.string().optional(),
        ref: z.string().optional().default("HEAD"),
      },
      async (args, _toolCtx, env) => {
        const headers: Record<string, string> = {
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

        const out: Array<{ path: string; source_url: string; content: string }> = [];

        // Case A: fetch by IDs (preferred for ChatGPT)
        if (args.ids?.length) {
          for (const id of args.ids) {
            const meta = this.state.index[id];
            if (!meta) continue;
            // Use Git Blobs API when we have the blob SHA
            const blobUrl = `https://api.github.com/repos/${meta.owner}/${meta.repo}/git/blobs/${meta.sha}`;
            const rh = { ...headers, Accept: "application/vnd.github.raw" };
            const rr = await fetch(blobUrl, { headers: rh });
            if (!rr.ok) throw new Error(`GitHub blob fetch failed: ${rr.status} ${rr.statusText}`);
            const content = await rr.text();
            out.push({ path: meta.path, source_url: meta.html_url, content });
          }
        }

        // Case B: explicit owner/repo/path[/ref]
        if (args.path) {
          const owner = args.owner ?? DEFAULT_OWNER;
          const repo  = args.repo  ?? DEFAULT_REPO;
          const ref   = args.ref ?? "HEAD";
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(args.path)}?ref=${encodeURIComponent(ref)}`;
          const rh = { ...headers, Accept: "application/vnd.github.raw+json" };
          const rr = await fetch(url, { headers: rh });
          if (!rr.ok) throw new Error(`GitHub contents fetch failed: ${rr.status} ${rr.statusText}`);
          const content = await rr.text();
          out.push({
            path: args.path,
            source_url: `https://github.com/${owner}/${repo}/blob/${ref}/${args.path}`,
            content,
          });
        }

        return { content: [{ type: "json", json: { files: out } }] };
      }
    );
  }
}

// Expose the SSE endpoint (works with Cloudflare’s Remote MCP template)
export default GitHubAdapter.mount("/sse");
