import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Cloudflare Worker Remote MCP server exposing GitHub repo tools on per-repo routes:
 *   /<owner>/<repo>/(sse|mcp)
 *
 * Tools:
 *  - search: code search (uses GitHub Search API) with snippets
 *  - fetch: fetch file contents by search IDs (blob) or by explicit path (contents)
 *  - list_prs, get_pr, list_pr_commits
 *  - list_commits, get_commit_status, list_check_runs
 *  - list_workflows, list_workflow_files, get_workflow_file
 *  - list_workflow_runs, get_workflow_run, list_run_jobs
 *
 * Auth: set secret GITHUB_TOKEN on the Worker (fine‑grained PAT, read‑only). For public repos it's optional.
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
    "User-Agent": "mcp-github-repo-adapter/1.1 (+cloudflare-workers)",
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

function q(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v));
  return usp.toString();
}

export class MyMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "github-repo-adapter", version: "1.1.0" });
  initialState: State = { index: {} };

  async init() {
    // ---------- SEARCH ----------
    this.server.tool(
      "search",
      "Search code in this repo and return IDs usable by fetch(). Accepts a single parameter: { query: string }.",
      {
        query: z.string().describe("Search string with optional GitHub qualifiers (e.g., path:src language:ts)")
      },
      async ({ query }) => {
        const { owner, repo } = this.props;
        const qstr = encodeURIComponent([query, `repo:${owner}/${repo}`, "in:file"].join(" "));
        const url = `${GH_API}/search/code?q=${qstr}`;
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

    // ---------- FETCH ----------
    this.server.tool(
      "fetch",
      "Fetch file contents for a list of IDs or paths returned by search(). Accepts a single parameter: { ids: string[] }.",
      {
        ids: z.array(z.string()).describe("IDs returned by search (preferred) or repo-relative file paths").nonempty()
      },
      async ({ ids })) => {
        const { owner, repo } = this.props;
        const out: Array<{ path: string; source_url: string; content: string }> = [];

        for (const token of ids) {
          const meta = this.state.index[token];
          if (meta?.sha) {
            // Treat as blob SHA from search
            const blobUrl = `${GH_API}/repos/${owner}/${repo}/git/blobs/${meta.sha}`;
            const content = await ghText(this.env, blobUrl, "application/vnd.github.raw+json");
            out.push({ path: meta.path, source_url: meta.html_url, content });
            continue;
          }
          // Otherwise treat token as a path
          const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(token)}?ref=HEAD`;
          const content = await ghText(this.env, url, "application/vnd.github.raw+json");
          out.push({ path: token, source_url: `https://github.com/${owner}/${repo}/blob/HEAD/${token}`, content });
        }

        return { content: [{ type: "json", json: { files: out } }] };
      }
    );
            out.push({ path: meta.path, source_url: meta.html_url, content });
          }
        }

        if (args.path) {
          const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(args.path)}?${q({ ref: args.ref })}`;
          const content = await ghText(this.env, url, "application/vnd.github.raw+json");
          out.push({ path: args.path, source_url: `https://github.com/${owner}/${repo}/blob/${args.ref}/${args.path}`, content });
        }

        return { content: [{ type: "json", json: { files: out } }] };
      }
    );

    // ---------- PULL REQUESTS ----------
    this.server.tool(
      "list_prs",
      "List pull requests for this repo.",
      {
        state: z.enum(["open", "closed", "all"]).optional().default("open"),
        head: z.string().optional(),
        base: z.string().optional(),
        sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        per_page: z.number().int().min(1).max(100).optional().default(30),
        page: z.number().int().min(1).max(50).optional().default(1),
      },
      async (args) => {
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
      "Get a single pull request by number.",
      { number: z.number().int() },
      async ({ number }) => {
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
      "List commits that belong to a PR.",
      { number: z.number().int(), per_page: z.number().int().min(1).max(100).optional().default(30), page: z.number().int().min(1).max(50).optional().default(1) },
      async ({ number, per_page, page }) => {
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

    // ---------- COMMITS / STATUSES ----------
    this.server.tool(
      "list_commits",
      "List commits on a branch or for the repo.",
      {
        sha: z.string().optional(),
        path: z.string().optional(),
        author: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional().default(30),
        page: z.number().int().min(1).max(50).optional().default(1),
      },
      async (args) => {
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
      "Get combined commit status + checks + recent workflow runs for a ref.",
      { ref: z.string().describe("Commit SHA, branch name, or tag") },
      async ({ ref }) => {
        const { owner, repo } = this.props;
        const combined = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`);
        const checks = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`);
        const workflows = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/actions/runs?${q({ head_sha: ref, per_page: 10 })}`);
        const result = {
          state: combined.state,
          statuses: (combined.statuses ?? []).map((s: any) => ({
            context: s.context,
            state: s.state,
            description: s.description,
            target_url: s.target_url,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
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

    this.server.tool(
      "list_check_runs",
      "List check runs for a commit ref.",
      { ref: z.string() },
      async ({ ref }) => {
        const { owner, repo } = this.props;
        const data = await ghJson<any>(this.env, `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`);
        return { content: [{ type: "json", json: data }] };
      }
    );

    // ---------- ACTIONS ----------
    this.server.tool(
      "list_workflows",
      "List Actions workflows in this repo.",
      {},
      async () => {
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
      "List files in .github/workflows (YAML).",
      {},
      async () => {
        const { owner, repo } = this.props;
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
      "Fetch the contents of a workflow YAML path.",
      { path: z.string() },
      async ({ path }) => {
        const { owner, repo } = this.props;
        const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
        const content = await ghText(this.env, url, "application/vnd.github.raw+json");
        return { content: [{ type: "json", json: { path, content } }] };
      }
    );

    this.server.tool(
      "list_workflow_runs",
      "List workflow runs (filterable).",
      {
        branch: z.string().optional(),
        event: z.string().optional(),
        status: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional().default(30),
        page: z.number().int().min(1).max(50).optional().default(1),
      },
      async (args) => {
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
      "Get a single workflow run by run_id.",
      { run_id: z.number().int() },
      async ({ run_id }) => {
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
      "List jobs for a workflow run.",
      { run_id: z.number().int(), per_page: z.number().int().min(1).max(100).optional().default(30), page: z.number().int().min(1).max(50).optional().default(1) },
      async ({ run_id, per_page, page }) => {
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/(sse|mcp)(?:\/.*)?$/);
    if (!m) return new Response("Not found. Use /<owner>/<repo>/(sse|mcp)", { status: 404 });
    const [, ownerEnc, repoEnc, mode] = m;
    const owner = decodeURIComponent(ownerEnc);
    const repo = decodeURIComponent(repoEnc);

    (ctx as any).props = { owner, repo } satisfies Props;
    const base = `/${owner}/${repo}/${mode}`;

    return mode === "sse"
      ? MyMCP.serveSSE(base).fetch(request, env, ctx)
      : MyMCP.serve(base).fetch(request, env, ctx);
  },
};
