import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** relies on your existing module-level vars: OWNER, REPO, LIMIT, HEADERS */
type SearchItem = { id: string; title: string; url: string };
type Doc = { id: string; title: string; text: string; url: string; metadata?: Record<string, unknown> };

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "GitHub Repo MCP", version: "1.0.0" });

async init() {
  // EXACTLY like your original contract: string in, string in
  this.server.tool(
    "search",
    z.string(),
    (query: string) => this.handleSearch(query)
  );

  this.server.tool(
    "fetch",
    z.string(),
    (id: string) => this.handleFetch(id)
  );
}

  /* ----------------- tiny helpers (SRP + DRY) ----------------- */

  private repoScope(): string {
    return `repo:${OWNER}/${REPO}`;
  }

  private ghUrl(path: string, params?: Record<string, string | number>) {
    const base = "https://api.github.com";
    const q = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : "";
    return `${base}${path}${q}`;
  }

  /** robust fetch → always returns JSON or throws a clear Error */
  private async ghGet(url: string): Promise<any> {
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";

    // non-JSON (like “Request forbidden by administrative rules.”)
    if (!ct.includes("application/json")) {
      const head = text.trim().slice(0, 300);
      if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}: ${head}`);
      try { return JSON.parse(text); } catch { return { note: head }; }
    }

    let data: any;
    try { data = JSON.parse(text); }
    catch {
      const head = text.trim().slice(0, 300);
      throw new Error(`GitHub ${res.status} ${res.statusText}: ${head}`);
    }

    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || text.trim().slice(0, 300);
      throw new Error(`GitHub ${res.status} ${res.statusText}: ${msg}`);
    }
    return data;
  }

  private buildSearchUrls(query: string) {
    const baseQ = this.repoScope();
    const issuesURL  = this.ghUrl("/search/issues",  { q: `${baseQ} is:issue ${query}`,  per_page: String(LIMIT) });
    const prsURL     = this.ghUrl("/search/issues",  { q: `${baseQ} is:pr ${query}`,     per_page: String(LIMIT) });
    const commitsURL = this.ghUrl("/search/commits", { q: `${baseQ} ${query}`,           per_page: String(LIMIT) });
    const codeURL    = this.ghUrl("/search/code",    { q: `${baseQ} ${query}`,           per_page: String(LIMIT) });
    return { issuesURL, prsURL, commitsURL, codeURL };
  }

  private mapIssueItem(it: any): SearchItem | null {
    if (!it || it.number == null) return null;
    return { id: `issue:${it.number}`, title: it.title ?? `Issue #${it.number}`, url: it.html_url };
  }
  private mapPrItem(it: any): SearchItem | null {
    if (!it || it.number == null) return null;
    return { id: `pr:${it.number}`, title: it.title ?? `PR #${it.number}`, url: it.html_url };
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

  /* ----------------- tools ----------------- */

  private async handleSearch(query: string) {
    try {
      const { issuesURL, prsURL, commitsURL, codeURL } = this.buildSearchUrls(query);
      const [ri, rp, rc, rcode] = await Promise.all([
        this.ghGet(issuesURL),
        this.ghGet(prsURL),
        this.ghGet(commitsURL),
        this.ghGet(codeURL),
      ]);

      const results: SearchItem[] = [];
      for (const it of ri?.items ?? [])    { const x = this.mapIssueItem(it);  if (x) results.push(x); }
      for (const it of rp?.items ?? [])    { const x = this.mapPrItem(it);     if (x) results.push(x); }
      for (const it of rc?.items ?? [])    { const x = this.mapCommitItem(it); if (x) results.push(x); }
      for (const it of rcode?.items ?? []) { const x = this.mapCodeItemFromSearch(it); if (x) results.push(x); }

      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err?.message || err) }) }] };
    }
  }

  private async handleFetch(id: string) {
    try {
      const [kind, value] = id.split(":");
      let doc: Doc;

      if (kind === "issue")       doc = await this.fetchIssue(value);
      else if (kind === "pr")     doc = await this.fetchPr(value);
      else if (kind === "commit") doc = await this.fetchCommit(value);
      else if (kind === "code")   doc = await this.fetchCodeBlob(value);
      else                        doc = { id, title: "Unknown ID", text: "Use: issue, pr, commit, or code", url: "", metadata: {} };

      return { content: [{ type: "text", text: JSON.stringify(doc) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err?.message || err) }) }] };
    }
  }

  /* ----------------- per-kind fetchers ----------------- */

  private async fetchIssue(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/issues/${value}`);
    const j = await this.ghGet(url);
    return { id: `issue:${value}`, title: j.title ?? `Issue #${value}`, text: j.body ?? "", url: j.html_url ?? url, metadata: { state: j.state, labels: j.labels, number: j.number } };
  }

  private async fetchPr(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/pulls/${value}`);
    const j = await this.ghGet(url);
    return { id: `pr:${value}`, title: j.title ?? `PR #${value}`, text: j.body ?? "", url: j.html_url ?? url, metadata: { state: j.state, merged: j.merged, head: j.head, base: j.base, number: j.number } };
  }

  private async fetchCommit(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/commits/${value}`);
    const j = await this.ghGet(url);
    const msg = j?.commit?.message ?? "";
    const title = msg.split("\n")[0] || `Commit ${value.slice(0, 7)}`;
    return { id: `commit:${value}`, title, text: msg, url: j.html_url ?? url, metadata: { author: j.commit?.author, committer: j.commit?.committer, sha: value } };
  }

  private async fetchCodeBlob(value: string): Promise<Doc> {
    const url = this.ghUrl(`/repos/${OWNER}/${REPO}/git/blobs/${value}`);
    const j = await this.ghGet(url);
    const text = j?.encoding === "base64" && j?.content ? atob(String(j.content).replace(/\n/g, "")) : "";
    return { id: `code:${value}`, title: `blob ${value}`, text, url, metadata: { size: j.size, encoding: j.encoding, sha: value } };
  }
}
