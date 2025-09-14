import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Cloudflare Worker Remote MCP server that exposes GitHub repo tools
 * on per-repository routes: /<owner>/<repo>/(sse|mcp)
 *
 * Tools exposed (all repo-scoped):
 *  - search: code search with optional qualifiers
 *  - fetch: fetch file contents by path or search ids
 *  - list_prs / get_pr / list_pr_commits
 *  - list_commits
 *  - get_commit_status (combined statuses + checks)
 *  - list_workflows / list_workflow_files / get_workflow_file
 *  - list_workflow_runs / get_workflow_run / list_run_jobs
 *
 * Authentication to GitHub is via the environment secret GITHUB_TOKEN (optional for public repos).
 * If set, we include Authorization: Bearer <token> and X-GitHub-Api-Version headers on all requests.
 */

type Env = {
  GITHUB_TOKEN?: string;
};

type State = {
  index: Record<string, { owner: string; repo: string; path: string; sha?: string; html_url: string }>;
};

type Props = { owner: string; repo: string };

// --------- Utility helpers ---------
const GH_API = "https://api.github.com";

function ghHeaders(env: Env, accept: string = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-github-repo-adapter/1.0 (+cloudflare-workers)",
  };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function ghJson<T>(env: Env, url: string, accept?: string): Promise<T> {
  const r = await fetch(url, { headers: ghHeaders(env, accept) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GitHub API ${r.status} ${r.statusText} for ${url}${body ? `\n${body}` : ""}`);
  }
  return (await r.json()) as T;
}

async function ghText(env: Env, url: string, accept: string): Promise<string> {
  const r = await fetch(url, { headers: ghHeaders(env, accept) });
  if (!r.ok) throw new Error(`GitHub API ${r.status} ${r.statusText} for ${url}`);
  return await r.text();
}

function q(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v));
  return usp.toString();
}

// --------- MCP Agent ---------
export class MyMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "github-repo-adapter", version: "1.0.0" });
  initialState: State = { index: {} };

  async init() {
    // --- search (code search within repo) ---
    this.server.tool(
      "search",
      z.object({
        query: z.string().describe("Search string"),
        path: z.string().optional(),
        language: z.string().optional(),
        filename: z.string().optional(),
        extension: z.string().optional(),
        subset: z.enum(["code", "docs"]).optional().default("code"),
        per_page: z.number().int().min(1).max(50).optional().default(10),
        page: z.number().int().min(1).max(10).optional().default(1),
      }),
      async ($1) => {
        const { owner, repo } = this.props;
        const { query, path, language, filename, extension, subset, per_page, page } = args;
        const quals: string[] = [`repo:${owner}/${repo}`, "in:file"];
        if (path) quals.push(`path:${path}`);
        if (language) quals.push(`language:${language}`);
        if (filename) quals.push(`filename:${filename}`);
        if (extension) quals.push(`extension:${extension}`);
        if (subset === "docs") quals.push("path:docs", "filename:README", "extension:md");
        const qstr = encodeURIComponent([query, ...quals].join(" "));
        const url = `${GH_API}/search/code?q=${qstr}&${q({ per_page, page })}`;
        const data = await ghJson<any>(this.env, url, "application/vnd.github.text-match+json");
        const results = (data.items ?? []).map((it: any) => {
          const id = it.sha as string;
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

    // --- fetch (by ids or by explicit path) ---
    this.server.tool(
      "fetch",
      z.object({
        ids: z.array(z.string()).optional(),
        path: z.string().optional(),
        ref: z.string().optional().default("HEAD"),
      }),
      async ($1) => {
        const { owner, repo } = this.props;
        const out: Array<{ path: string; source_url: string; content: string }> = [];

        // by IDs → Git Blob API (raw)
        if (args.ids?.length) {
          for (const id of args.ids) {
            const meta = this.state.index[id];
            if (!meta?.sha) continue;
            const blobUrl = `${GH_API}/repos/${owner}/${repo}/git/blobs/${meta.sha}`;
            const content = await ghText(this.env, blobUrl, "application/vnd.github.raw+json");
            out.push({ path: meta.path, source_url: meta.html_url, content });
          }
        }

        // by path → Contents API (raw)
        if (args.path) {
          const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(args.path)}?${q({ ref: args.ref })}`;
          const content = await ghText(this.env, url, "application/vnd.github.raw+json");
          out.push({ path: args.path, source_url: `https://github.com/${owner}/${repo}/blob/${args.ref}/${args.path}`, content });
        }

        return { content: [{ type: "json", json: { files: out } }] };
      }
    );

    // --- Pull Requests ---
    this.server.tool(
      "list_prs",
      z.object({
        state: z.enum(["open", "closed", "all"]).optional().default("open"),
        head: z.string().optional(),
        base: z.string().optional(),
        sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        per_page: z.number().int().min(1).max(100).optional().default(30),
        page: z.number().int().min(1).max(50).optional().default(1),
      }),
      async ($1) => {
        const { owner, repo } = this.props;
        const url = `${GH_API}/repos/${owner}/${repo}/pulls?${q(args as any)}`;
        const items = await ghJson<any[]>(this.env, url);
        const pulls = items.map((p) => ({
          id: p.id,
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          user: p.user?.login,
          head: { ref: p.head?.ref, sha: p.head?.sha },
          base: { ref: p.base?.ref, sha: p.base?.sha },
          html_url: p.html_url,
          created_at: p.created_at,
          updated_at: p.updated_at,
          merged_at: p.merged_at ?? null,
        }));
        return { content: [{ type: "json", json: { pulls } }] };
      }
    );

    this.server.tool(
      "get_pr",
      z.object({ number: z.number().int() }),
      async ($1) => {
        const { owner, repo } = this.props;
        const p = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/pulls/${number}`);
        const pr = {
          id: p.id,
          number: p.number,
          title: p.title,
          body: p.body ?? null,
          state: p.state,
          draft: p.draft,
          user: p.user?.login,
          head: { ref: p.head?.ref, sha: p.head?.sha },
          base: { ref: p.base?.ref, sha: p.base?.sha },
          html_url: p.html_url,
          created_at: p.created_at,
          updated_at: p.updated_at,
          merged_at: p.merged_at ?? null,
        };
        return { content: [{ type: "json", json: { pr } }] };
      }
    );

    this.server.tool(
      "list_pr_commits",
      z.object({ number: z.number().int(), per_page: z.number().int().min(1).max(100).optional().default(30), page: z.number().int().min(1).max(50).optional().default(1) }),
      async ($1) => {
        const { owner, repo } = this.props;
        const url = `${GH_API}/repos/${owner}/${repo}/pulls/${number}/commits?${q({ per_page, page })}`;
        const items = await ghJson<any[]>(this.env, url);
        const commits = items.map((c) => ({
          sha: c.sha,
          message: c.commit?.message,
          author: c.commit?.author?.name ?? c.author?.login ?? null,
          date: c.commit?.author?.date,
          html_url: c.html_url ?? `https://github.com/${owner}/${repo}/commit/${c.sha}`,
        }));
        return { content: [{ type: "json", json: { commits } }] };
      }
    );

    // --- Commits ---
    this.server.tool(
      "list_commits",
      z.object({
        sha: z.string().optional(),
        path: z.string().optional(),
        author: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional().default(30),
        page: z.number().int().min(1).max(50).optional().default(1),
      }),
      async ($1) => {
        const { owner, repo } = this.props;
        const url = `${GH_API}/repos/${owner}/${repo}/commits?${q(args as any)}`;
        const items = await ghJson<any[]>(this.env, url);
        const commits = items.map((c) => ({
          sha: c.sha,
          message: c.commit?.message,
          author: c.commit?.author?.name ?? c.author?.login ?? null,
          date: c.commit?.author?.date,
          html_url: `https://github.com/${owner}/${repo}/commit/${c.sha}`,
        }));
        return { content: [{ type: "json", json: { commits } }] };
      }
    );

    this.server.tool(
      "get_commit_status",
      z.object({ ref: z.string().describe("Commit SHA, branch name, or tag") }),
      async ($1) => {
        const { owner, repo } = this.props;
        const combined = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`);
        const checks = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`);
        const workflows = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/actions/runs?${q({ head_sha: ref, per_page: 10 })}`);
        const result = {
          state: combined.state, // success | failure | pending | error
          statuses: combined.statuses?.map((s: any) => ({
            context: s.context,
            state: s.state,
            description: s.description,
            target_url: s.target_url,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })) ?? [],
          checks: (checks.check_runs ?? []).map((r: any) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            app: r.app?.slug,
            started_at: r.started_at,
            completed_at: r.completed_at,
            html_url: r.html_url,
          })),
          runs: (workflows.workflow_runs ?? []).map((wr: any) => ({
            id: wr.id,
            name: wr.name,
            status: wr.status,
            conclusion: wr.conclusion,
            event: wr.event,
            head_branch: wr.head_branch,
            head_sha: wr.head_sha,
            html_url: wr.html_url,
            run_number: wr.run_number,
            created_at: wr.created_at,
            updated_at: wr.updated_at,
          })),
        };
        return { content: [{ type: "json", json: result }] };
      }
    );

    // --- Actions: workflows and runs ---
    this.server.tool(
      "list_workflows",
      z.object({}),
      async ($1) => {
        const { owner, repo } = this.props;
        const data = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/actions/workflows`);
        const workflows = (data.workflows ?? []).map((w: any) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          state: w.state,
          html_url: w.html_url,
          created_at: w.created_at,
          updated_at: w.updated_at,
        }));
        return { content: [{ type: "json", json: { workflows } }] };
      }
    );

    this.server.tool(
      "list_workflow_files",
      z.object({}),
      async ($1) => {
        const { owner, repo } = this.props;
        // List files in .github/workflows (if the directory exists)
        const url = `${GH_API}/repos/${owner}/${repo}/contents/.github/workflows`;
        const entries = await ghJson<any[]>(this.env, url).catch(() => []);
        const files = Array.isArray(entries)
          ? entries.filter((e) => e.type === "file" && /\.(ya?ml)$/i.test(e.name)).map((e) => ({ name: e.name, path: e.path, download_url: e.download_url }))
          : [];
        return { content: [{ type: "json", json: { files } }] };
      }
    );

    this.server.tool(
      "get_workflow_file",
      z.object({ path: z.string() }),
      async ($1) => {
        const { owner, repo } = this.props;
        const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
        const content = await ghText(this.env, url, "application/vnd.github.raw+json");
        return { content: [{ type: "json", json: { path, content } }] };
      }
    );

    this.server.tool(
      "list_workflow_runs",
      z.object({
        branch: z.string().optional(),
        event: z.string().optional(),
        status: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional().default(30),
        page: z.number().int().min(1).max(50).optional().default(1),
      }),
      async ($1) => {
        const { owner, repo } = this.props;
        const url = `${GH_API}/repos/${owner}/${repo}/actions/runs?${q(args as any)}`;
        const data = await ghJson<any>(this.env, url);
        const runs = (data.workflow_runs ?? []).map((wr: any) => ({
          id: wr.id,
          name: wr.name,
          status: wr.status,
          conclusion: wr.conclusion,
          event: wr.event,
          head_branch: wr.head_branch,
          head_sha: wr.head_sha,
          html_url: wr.html_url,
          run_number: wr.run_number,
          created_at: wr.created_at,
          updated_at: wr.updated_at,
        }));
        return { content: [{ type: "json", json: { runs } }] };
      }
    );

    this.server.tool(
      "get_workflow_run",
      z.object({ run_id: z.number().int() }),
      async ($1) => {
        const { owner, repo } = this.props;
        const wr = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/actions/runs/${run_id}`);
        const run = {
          id: wr.id,
          name: wr.name,
          status: wr.status,
          conclusion: wr.conclusion,
          event: wr.event,
          head_branch: wr.head_branch,
          head_sha: wr.head_sha,
          html_url: wr.html_url,
          run_number: wr.run_number,
          created_at: wr.created_at,
          updated_at: wr.updated_at,
        };
        return { content: [{ type: "json", json: { run } }] };
      }
    );

    this.server.tool(
      "list_run_jobs",
      z.object({ run_id: z.number().int(), per_page: z.number().int().min(1).max(100).optional().default(30), page: z.number().int().min(1).max(50).optional().default(1) }),
      async ($1) => {
        const { owner, repo } = this.props;
        const data = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/actions/runs/${run_id}/jobs?${q({ per_page, page })}`);
        const jobs = (data.jobs ?? []).map((j: any) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          started_at: j.started_at,
          completed_at: j.completed_at,
          html_url: j.html_url,
          steps: (j.steps ?? []).map((s: any) => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number, started_at: s.started_at, completed_at: s.completed_at })),
        }));
        return { content: [{ type: "json", json: { jobs } }] };
      }
    );
  }
}

// --------- Worker routing ---------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Expect: /<owner>/<repo>/(sse|mcp)
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/(sse|mcp)(?:\/.*)?$/);
    if (!m) {
      return new Response("Not found. Use /<owner>/<repo>/(sse|mcp)", { status: 404 });
    }

    const [, ownerEnc, repoEnc, mode] = m;
    const owner = decodeURIComponent(ownerEnc);
    const repo = decodeURIComponent(repoEnc);

    // Pass repo-scoped props into the agent instance
    // (The Agents SDK reads ctx.props and exposes as this.props)
    (ctx as any).props = { owner, repo } satisfies Props;

    const base = `/${owner}/${repo}/${mode}`;

    // Support both transports: SSE and Streamable HTTP
    if (mode === "sse") {
      return MyMCP.serveSSE(base).fetch(request, env, ctx);
    } else {
      return MyMCP.serve(base).fetch(request, env, ctx);
    }
  },
};
