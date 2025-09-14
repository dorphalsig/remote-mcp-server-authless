import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  RESULTS_PER_CATEGORY?: string; // text var (default "5")
  GITHUB_TOKEN?: string;         // secret
}

/** single-user, minimal module state (kept like your template) */
let OWNER = "";
let REPO = "";
let LIMIT = 5;
let HEADERS: Record<string, string> = {};

/** helper shapes */
type SearchItem = { id: string; title: string; url: string };
type Doc = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, unknown>;
};

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "GitHub Repo MCP",
    version: "1.0.0",
  });

  async init() {
    const SearchInput = z.object({
      query: z.string().min(1, "query is required"),
      branch: z.string().optional(),
    });

    const FetchInput = z.object({
      id: z.string().min(1, "id is required"),
      branch: z.string().optional(),
    });

    this.server.tool(
      "search",
      SearchInput,
      async ({ query, branch }) => {
        const b = branch && branch.trim() ? branch.trim() : undefined;
        return this.handleSearch(query, b);
      }
    );

    this.server.tool(
      "fetch",
      FetchInput,
      async ({ id, branch }) => {
        const b = branch && branch.trim() ? branch.trim() : undefined;
        return this.handleFetch(id, b);
      }
    );
  }

  /* ----------------- helpers ----------------- */

  private repoScope(): string {
    return `repo:${OWNER}/${REPO}`;
  }

  private ghUrl(path: string, params?: Record<string, string | number>) {
    const base = "https://api.github.com";
    const q = params
      ? `?${new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)])
        )}`
      : "";
    return `${base}${path}${q}`;
  }

  /** robust JSON-or-text fetch with clear errors */
  private async ghGet(url: string): Promise<any> {
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";

    if (!ct.includes("application/json")) {
      const head = text.trim().slice(0, 300);
      if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}: ${head}`);
      try {
        return JSON.parse(text);
      } catch {
        return head;
      }
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      const head = text.trim().slice(0, 300);
      throw new Error(`GitHub ${res.status} ${res.statusText}: ${head}`);
    }

    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || text.trim().slice(0, 300);
      throw new Error(`GitHub ${res.status} ${res.statusText}: ${msg}`);
    }

    return data;
  }

  private safeAtob(b64: string): string {
    try {
      return atob(b64.replace(/\n/g, ""));
    } catch {
      return "";
    }
  }

  private buildSearchUrls(query: string) {
    const baseQ = this.repoScope();
    const issuesURL = this.ghUrl("/search/issues", {
      q: `${baseQ} is:issue ${query}`,
      per_page: String(LIMIT),
    });
    const prsURL = this.ghUrl("/search/issues", {
      q: `${baseQ} is:pr ${query}`,
      per_page: String(LIMIT),
    });
    const commitsURL = this.ghUrl("/search/commits", {
      q: `${baseQ} ${query}`,
      per_page: String(LIMIT),
    });
    const codeURL = this.ghUrl("/search/code", {
      q: `${baseQ} ${query}`,
      per_page: String(LIMIT),
    });
    return { issuesURL, prsURL, commitsURL, codeURL };
  }

  private mapIssueItem(it: any): SearchItem | null {
    if (!it || it.number == null) return null;
    return {
      id: `issue:${it.number}`,
      title: it.title ?? `Issue #${it.number}`,
      url: it.html_url,
    };
  }

  private mapPrItem(it: any): SearchItem | null {
    if (!it || it.number == null) return null;
    return {
      id: `pr:${it.number}`,
      title: it.title ?? `PR #${it.number}`,
      url: it.html_url,
    };
  }

  private mapCommitItem(it: any): SearchItem | null {
    if (!it?.sha) return null;
    const sha = String(it.sha);
    const msg = (it.commit?.message ?? "").split("\n")[0] || `Commit ${sha.slice(0, 7)}`;
    return { id: `commit:${sha}`, title: msg, url: it.html_url || `https://github.com/${OWNER}/${REPO}/commit/${sha}` };
  }

  private mapCodeItemFromSearch(it: any): SearchItem | null {
    if (!it?.sha) return null;
    const sha = String(it.sha);
    const path = it.path ?? sha;
    return { id: `code:${sha}`, title: path, url: it.html_url };
  }

  private mapCodeItemFromTree(entry: any, branch: string): SearchItem | null {
    if (!entry || entry.type !== "blob" || !entry.sha || !entry.path) return null;
    const sha = String(entry.sha);
    const path = String(entry.path);
    const url = `https://github.com/${OWNER}/${REPO}/blob/${encodeURIComponent(branch)}/${encodeURI(path)}`;
    return { id: `code:${sha}`, title: path, url };
  }

  private async resolveBranchHeadSha(branch: string): Promise<string | null> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/branches/${branch}`);
    const j = await this.ghGet(url);
    const sha = j && j.commit && j.commit.sha ? String(j.commit.sha) : null;
    return sha;
  }

  private async searchCommitsOnBranch(branch: string, query: string): Promise<SearchItem[]> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/commits`, { sha: branch, per_page: 100 });
    const commits = Array.isArray(await this.ghGet(url)) ? await this.ghGet(url) : [];
    const q = query.trim().toLowerCase();
    const out: SearchItem[] = [];
    for (const c of commits) {
      const sha = c && c.sha ? String(c.sha) : "";
      if (!sha) continue;
      const msg = c.commit && c.commit.message ? String(c.commit.message) : "";
      if (!q || msg.toLowerCase().includes(q) || sha.includes(q)) {
        const title = msg.split("\n")[0] || `Commit ${sha.slice(0, 7)}`;
        const html = `https://github.com/${OWNER}/${REPO}/commit/${sha}`;
        out.push({ id: `commit:${sha}`, title, url: html });
        if (out.length >= LIMIT) break;
      }
    }
    return out;
  }

  private async searchCodePathsOnBranch(branch: string, query: string): Promise<SearchItem[]> {
    const headSha = await this.resolveBranchHeadSha(branch);
    if (!headSha) return [];
    const treeUrl = this.ghUrl(`/repos/${OWNER}/${REPO}/git/trees/${headSha}`, { recursive: 1 });
    const tree = await this.ghGet(treeUrl);
    const entries = Array.isArray(tree?.tree) ? tree.tree : [];
    const q = query.trim().toLowerCase();
    const results: SearchItem[] = [];
    for (const e of entries) {
      if (e?.type !== "blob" || !e?.path) continue;
      const path = String(e.path);
      if (!q || path.toLowerCase().includes(q)) {
        const mapped = this.mapCodeItemFromTree(e, branch);
        if (mapped) results.push(mapped);
        if (results.length >= LIMIT) break;
      }
    }
    return results;
  }

  /* ----------------- tool handlers ----------------- */

  private async handleSearch(query: string, branch?: string) {
    try {
      if (branch) {
        const baseQ = this.repoScope();
        const issuesURL = this.ghUrl("/search/issues", {
          q: `${baseQ} is:issue ${query}`,
          per_page: String(LIMIT),
        });
        const prsURL = this.ghUrl("/search/issues", {
          q: `${baseQ} is:pr ${query}`,
          per_page: String(LIMIT),
        });

        const [ji, jp, commitItems, codeItems] = await Promise.all([
          this.ghGet(issuesURL),
          this.ghGet(prsURL),
          this.searchCommitsOnBranch(branch, query),
          this.searchCodePathsOnBranch(branch, query),
        ]);

        const results: SearchItem[] = [];
        for (const it of ji?.items ?? []) {
          const x = this.mapIssueItem(it);
          if (x) results.push(x);
        }
        for (const it of jp?.items ?? []) {
          const x = this.mapPrItem(it);
          if (x) results.push(x);
        }
        results.push(...commitItems);
        results.push(...codeItems);

        return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
      }

      const { issuesURL, prsURL, commitsURL, codeURL } = this.buildSearchUrls(query);
      const [ri, rp, rc, rcode] = await Promise.all([
        this.ghGet(issuesURL),
        this.ghGet(prsURL),
        this.ghGet(commitsURL),
        this.ghGet(codeURL),
      ]);
      const results: SearchItem[] = [];
      for (const it of ri?.items ?? []) {
        const x = this.mapIssueItem(it);
        if (x) results.push(x);
      }
      for (const it of rp?.items ?? []) {
        const x = this.mapPrItem(it);
        if (x) results.push(x);
      }
      for (const it of rc?.items ?? []) {
        const x = this.mapCommitItem(it);
        if (x) results.push(x);
      }
      for (const it of rcode?.items ?? []) {
        const x = this.mapCodeItemFromSearch(it);
        if (x) results.push(x);
      }

      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    } catch (err: any) {
      const error = String(err?.message || err);
      return { content: [{ type: "text", text: JSON.stringify({ error }) }] };
    }
  }

  private async handleFetch(id: string, branch?: string) {
    try {
      const [kind, value] = id.split(":");
      let doc: Doc;

      if (kind === "issue") {
        doc = await this.fetchIssue(value);
      } else if (kind === "pr") {
        doc = await this.fetchPr(value);
      } else if (kind === "commit") {
        doc = await this.fetchCommit(value);
      } else if (kind === "code") {
        doc = await this.fetchCodeBlob(value);
      } else {
        doc = { id, title: "Unknown ID", text: "Use: issue, pr, commit, or code", url: "", metadata: {} };
      }

      return { content: [{ type: "text", text: JSON.stringify(doc) }] };
    } catch (err: any) {
      const error = String(err?.message || err);
      return { content: [{ type: "text", text: JSON.stringify({ error }) }] };
    }
  }

  private async fetchIssue(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/issues/${value}`);
    const j = await this.ghGet(url);
    return {
      id: `issue:${value}`,
      title: j.title ?? `Issue #${value}`,
      text: j.body ?? "",
      url: j.html_url ?? url,
      metadata: { state: j.state, labels: j.labels, number: j.number },
    };
  }

  private async fetchPr(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/pulls/${value}`);
    const j = await this.ghGet(url);
    return {
      id: `pr:${value}`,
      title: j.title ?? `PR #${value}`,
      text: j.body ?? "",
      url: j.html_url ?? url,
      metadata: { state: j.state, merged: j.merged, head: j.head, base: j.base, number: j.number },
    };
  }

  private async fetchCommit(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/commits/${value}`);
    const j = await this.ghGet(url);
    const msg = j?.commit?.message ?? "";
    const title = msg.split("\n")[0] || `Commit ${value.slice(0, 7)}`;
    return {
      id: `commit:${value}`,
      title,
      text: msg,
      url: j.html_url ?? url,
      metadata: { author: j.commit?.author, committer: j.commit?.committer, sha: value },
    };
  }

  private async fetchCodeBlob(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/git/blobs/${value}`);
    const j = await this.ghGet(url);
    const text = j?.encoding === "base64" && j?.content ? this.safeAtob(String(j.content)) : "";
    return {
      id: `code:${value}`,
      title: `blob ${value}`,
      text,
      url,
      metadata: { size: j.size, encoding: j.encoding, sha: value },
    };
  }
}

/** worker entry — same routes, module state set per request */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    const valid =
      (parts.length === 3 && (parts[2] === "sse" || parts[2] === "mcp")) ||
      (parts.length === 4 && parts[2] === "sse" && parts[3] === "message");

    if (!valid) return new Response("Not found", { status: 404 });

    OWNER = parts[0];
    REPO = parts[1];

    const raw = env.RESULTS_PER_CATEGORY ?? "5";
    const n = parseInt(raw, 10);
    LIMIT = Number.isFinite(n) && n > 0 ? n : 5;

    HEADERS = {
      Accept: "application/vnd.github+json",
      "User-Agent": "mcp-server",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (env.GITHUB_TOKEN) HEADERS.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

    const prefix = `/${OWNER}/${REPO}`;
    if (url.pathname === `${prefix}/sse` || url.pathname === `${prefix}/sse/message`) {
      // @ts-ignore provided by Cloudflare Agents SDK
      return MyMCP.serveSSE(`${prefix}/sse`).fetch(request, env, ctx);
    }
    if (url.pathname === `${prefix}/mcp`) {
      // @ts-ignore provided by Cloudflare Agents SDK
      return MyMCP.serve(`${prefix}/mcp`).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
