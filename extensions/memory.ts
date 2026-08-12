// OKF memory store for pi. Layout: ~/.pi/memories/<escaped-cwd>/  (one bundle per project).
// Three tools: mem_get (查 list/search/read) · mem_put (编 write/edit) · mem_del (删 delete).
// OKF = markdown + YAML frontmatter; only `type` is required. No deps; frontmatter hand-built & regex-scanned.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFile, writeFile, unlink, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { spawn } from "node:child_process";

// ── Wiki-style internal links: [[target]] or [[target|alias]] ───────────────────
// Concepts link to each other via [[id]]. Forward links are parsed from the body;
// backlinks are computed at read time ("automatic bi-directional linking").
// A target ends at ] or |, so [[auth]] ≠ concept "auth2" and [[notes/auth]] targets
// "notes/auth" not "notes". Same extractor used both ways → consistent boundaries.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
function wikiLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

const MEM_ROOT = resolve(process.env.HOME || "", ".pi/memories");

/**
 * Spawn a binary directly (no `bash -c`) and return {stdout, stderr, code}.
 * Inline historically used a bare `exec(shellString)` that was never defined —
 * it threw `exec is not defined`, which broke mem_get search outright and made
 * gitAuto fail silently (swallowed by its catch). Spawning the binary directly
 * with an argv array avoids relying on `/bin/bash` (absent from the node
 * process view on Windows) and avoids shell-quoting the rg regex / git paths.
 */
function exec(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { shell: false, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      // binary missing / failed to spawn — surface as a real error (code -1).
      resolvePromise({ stdout, stderr: stderr || `${bin}: ${err.message}`, code: -1 });
    });
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// '/' → '---', other unsafe chars → '_'. Human-readable & reversible-ish.
// e.g. /root/myproject → root---myproject.
function escapeCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return (parts.join("---").replace(/[^a-zA-Z0-9._-]+/g, "_") || "_root");
}
const bundleRoot = (cwd: string) => join(MEM_ROOT, escapeCwd(cwd));
const idToFile = (cwd: string, id: string) => join(bundleRoot(cwd), id.replace(/^\/+/, "")) + ".md";
// Normalize '\' → '/' so concept ids are forward-slash on every platform (Windows
// path.relative() returns backslashes, which would break [[a/b]] wikilink matching
// and list/backlink display).
const fileToId = (cwd: string, file: string) =>
  relative(bundleRoot(cwd), file).replace(/\.md$/i, "").replace(/\\+/g, "/");

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try {
      s = await stat(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(p);
    else if (extname(p).toLowerCase() === ".md") yield p;
  }
}

// Build the "Linked concepts" footer appended on read-by-id: forward links
// (resolved ✓ / missing ✗) parsed from this concept's body, plus backlinks
// (concepts that link TO this one). Both are computed; nothing is stored.
// ponytail: O(all wikilinks in bundle) per read; fine for a single-user store.
// Add a backlink index file if bundles grow large and reads get slow.
async function linksFooter(cwd: string, id: string, text: string): Promise<string> {
  const root = bundleRoot(cwd);
  const { body } = splitFrontmatter(text);
  const fw = wikiLinks(body);
  // de-dup, preserve order
  const seen = new Set<string>();
  const forward = [...new Set(fw.filter((t) => !seen.has(t) && seen.add(t)))];

  const back: string[] = [];
  for await (const f of walk(root)) {
    const otherId = fileToId(cwd, f);
    if (otherId === id) continue;
    const t = await readFile(f, "utf8").catch(() => "");
    const { body: ob } = splitFrontmatter(t);
    if (wikiLinks(ob).includes(id)) back.push(otherId);
  }

  const lines: string[] = ["", "", "---", "", "## Linked concepts", ""];
  if (forward.length) {
    lines.push("### Forward links (from this concept)", "");
    for (const t of forward) {
      const exists = existsSync(idToFile(cwd, t));
      lines.push(`- [[${t}]] ${exists ? "✓" : "✗ (missing)"}`);
    }
    lines.push("");
  } else {
    lines.push("### Forward links", "", "_(none — add `[[other-concept-id]]` in the body to link)_", "");
  }
  if (back.length) {
    lines.push("### Backlinks (concepts linking here)", "");
    for (const b of [...new Set(back)].sort()) {
      const t = await readFile(idToFile(cwd, b), "utf8").catch(() => "");
      const title = fmField(splitFrontmatter(t).fm, "title") || b;
      lines.push(`- [[${b}]] — ${title}`);
    }
  } else {
    lines.push("### Backlinks", "", "_(none yet)_", "");
  }
  return lines.join("\n") + "\n";
}

function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: text };
}
function fmField(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}
function fmTags(fm: string): string[] {
  const arr = fm.match(/^tags:\s*\[(.*)\]\s*$/m);
  return arr
    ? arr[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
    : [];
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// OKF §3.1 reserved filenames, must never be concept ids at any level.
const RESERVED = new Set(["index", "log"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate a concept id: non-empty, no traversal, no reserved leaf.
// Returns an array of error strings (empty = valid).
function idErrors(id: string): string[] {
  const e: string[] = [];
  if (!id) e.push("id is empty");
  else {
    const segs = id.split("/");
    if (segs.some((s) => s === "" || s === "." || s === ".."))
      e.push(`id has empty/"."/".." segments (path traversal not allowed): ${JSON.stringify(id)}`);
    if (RESERVED.has(segs[segs.length - 1].replace(/\.md$/i, "").toLowerCase()))
      e.push(`leaf name "${segs[segs.length - 1]}" is reserved (OKF §3.1: index/log) — pick another name`);
  }
  return e;
}

// Throw a structured, actionable error; pi catches it, sets isError:true, and reports
// the message to the LLM as the tool result.
function fail(mode: string, problems: string[], fix: string): never {
  throw new Error(
    `mem_put${mode ? ` (${mode})` : ""} failed.\n` +
      `  problems: ${problems.join("; ")}\n` +
      `  fix: ${fix}`,
  );
}

// Auto-git each bundle: init on first use, then add+commit every mutation.
// ponytail: per-file queue only serializes same-file git; cross-file concurrent
// commits may race (last write wins the tree). Fine for a single-user memory store;
// add a bundle-level mutex if contention shows up.
async function gitAuto(root: string, message: string): Promise<void> {
  try {
    if (!existsSync(join(root, ".git"))) {
      await exec("git", ["init", "-q", root]);
      await exec("git", ["-C", root, "config", "user.email", "pi-memory@local"]);
      await exec("git", ["-C", root, "config", "user.name", "pi/memory"]);
    }
    await exec("git", ["-C", root, "add", "-A"]);
    await exec("git", ["-C", root, "commit", "-q", "-m", message]);
  } catch {
    // nothing to commit, or git missing — file op already succeeded, git is best-effort.
  }
}

function buildDoc(p: {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  status?: string;
  stale_after?: string;
  sources?: Array<{ title?: string; resource: string }>;
  body: string;
}): string {
  const lines: string[] = ["---"];
  lines.push(`type: ${p.type}`);
  if (p.title) lines.push(`title: ${JSON.stringify(p.title)}`);
  if (p.description) lines.push(`description: ${JSON.stringify(p.description)}`);
  if (p.resource) lines.push(`resource: ${p.resource}`);
  if (p.tags?.length) lines.push(`tags: [${p.tags.join(", ")}]`);
  // OKF §5 lifecycle: status (current|deprecated|superseded) + stale_after (YYYY-MM-DD).
  if (p.status) lines.push(`status: ${p.status}`);
  if (p.stale_after) lines.push(`stale_after: ${p.stale_after}`);
  lines.push("generated:", "  by: pi/memory", `  at: '${new Date().toISOString()}'`);
  if (p.sources?.length) {
    lines.push("sources:");
    for (const s of p.sources) {
      lines.push(`- title: ${JSON.stringify(s.title || s.resource)}`);
      lines.push(`  resource: ${s.resource}`);
    }
  }
  lines.push("---", "", p.body.replace(/^\n+/, ""));
  return lines.join("\n") + "\n";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    await mkdir(MEM_ROOT, { recursive: true }).catch(() => {});
  });

  // Urge the agent to actively use the memory tools by appending to the system prompt each turn.
  pi.on("before_agent_start", async (event) => {
    const urge = [
      "## Project memory (OKF) — USE IT ACTIVELY",
      "You have a persistent, per-project knowledge store via the `mem_get` / `mem_put` / `mem_del` tools. It survives across sessions. Treat it as your long-term memory for THIS project.",
      "- **Before acting on a task**, call `mem_get` (no args) to list existing concepts, or `mem_get` with a `query` (rg regex) if the task touches something specific. Do NOT re-derive knowledge that is already stored.",
      "- **Whenever you learn something durable** — a decision and its rationale, a convention, a gotcha/pitfall, an entity's shape, a workaround, a `ponytail:`-style deferral worth tracking — write it NOW with `mem_put` (write mode: id + concept_type + body; optional title/description/tags/status/stale_after). Do not wait until the end of the session.",
      "- Mark lifecycle: `status: deprecated` for superseded decisions, `stale_after: YYYY-MM-DD` for time-sensitive ones, so future-you knows what's still current.",
      "- Use `mem_put` edit mode (oldText/newText) for precise patches to long concepts instead of rewriting the whole file.",
      "- Use `mem_del` when a concept is outright wrong or obsolete — don't leave dead knowledge.",
      "- Link related concepts with `[[other-id]]` wiki links in the body (alias form `[[id|label]]`). `mem_get` by id then shows forward links (✓/✗) and auto-computed backlinks, so knowledge forms a bi-directional graph instead of isolated files.",
      "Default to checking memory first and writing memory as you go. A task that ignores an existing `notes/` or `decisions/` concept is a bug.",
    ].join("\n");
    return { systemPrompt: event.systemPrompt + "\n\n" + urge };
  });

  // ── 查: list / search / read ────────────────────────────────────────
  pi.registerTool({
    name: "mem_get",
    label: "Memory · get",
    description:
      "Read the OKF memory bundle for the current project (~/.pi/memories/<project>/). " +
      "If id is given → return that concept's raw markdown PLUS a `## Linked concepts` footer showing forward links `[[id]]` (✓ resolved / ✗ missing) and backlinks (concepts that link here). " +
      "Else if query is given → ripgrep search (query is an rg regex, case-insensitive) across frontmatter+body, return matching ids + line:snippet. " +
      "Else → list all concepts (id + title), optionally filtered by type/tag/status. " +
      "Concept id = file path rel bundle root without .md (e.g. 'notes/auth'). Leading @ stripped. Concepts link to each other via `[[other-id]]` wiki links in the body (alias form `[[id|label]]` supported).",
    promptSnippet: "List / search / read OKF memory concepts for the current project.",
    promptGuidelines: [
      "Before re-deriving project knowledge (decisions, conventions, entity docs), call mem_get to recall what's already persisted.",
      "Connect related concepts with `[[other-concept-id]]` wiki links in the body — backlinks are surfaced automatically in the read footer.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Concept id to read. Omit to search/list." })),
      query: Type.Optional(Type.String({ description: "ripgrep regex (case-insensitive). Ignored when id is given." })),
      type: Type.Optional(Type.String({ description: "Filter list by concept type." })),
      tag: Type.Optional(Type.String({ description: "Filter list by tag." })),
      status: Type.Optional(Type.String({ description: "Filter list by lifecycle status (e.g. current/deprecated/superseded)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const root = bundleRoot(cwd);

      // read one — raw markdown + a computed Linked-concepts footer (forward links + backlinks).
      if (params.id) {
        const id = params.id.replace(/^@/, "");
        const ie = idErrors(id);
        if (ie.length)
          throw new Error(`mem_get failed.\n  problems: ${ie.join("; ")}\n  fix: use a clean relative path like "notes/auth" — no "/"/".."/"." segments, leaf not "index"/"log".`);
        const text = await readFile(idToFile(cwd, id), "utf8").catch(() => null);
        if (text === null)
          throw new Error(`mem_get failed.\n  problems: concept "${id}" not found.\n  fix: call mem_get with no id to list all concepts, or check the id spelling.`);
        const footer = await linksFooter(cwd, id, text);
        return { content: [{ type: "text", text: text + footer }], details: {} };
      }

      // search — query is an rg regex, case-insensitive.
      // ponytail: shells out to ripgrep; no JS fallback. rg required at runtime.
      if (params.query) {
        let stdout = "";
        let rgCode = 0;
        let rgErr = "";
        try {
          const out = await exec("rg", ["-i", "-n", "--no-heading", "--", params.query, root]);
          stdout = out.stdout;
          rgCode = out.code;
          rgErr = out.stderr;
        } catch (e: unknown) {
          // spawn itself failed (rg missing) — exec resolves with code -1, but
          // guard against any synchronous throw too.
          rgCode = -1;
          rgErr = String((e as Error).message || e);
        }
        // rg exits 1 on no matches — not an error.
        if (rgCode === 1) {
          return { content: [{ type: "text", text: `(no matches for /${params.query}/)` }], details: {} };
        }
        if (rgCode !== 0) {
          throw new Error(`mem_get (search) failed.\n  problems: ripgrep error (exit ${rgCode}) — ${rgErr || "no stderr"}\n  fix: check that the query is a valid regex; rg is required at runtime.`);
        }
        // parse `path:line:match` lines, group by concept id
        const byId = new Map<string, string[]>();
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const sep = line.indexOf(":");
          const sep2 = line.indexOf(":", sep + 1);
          if (sep === -1 || sep2 === -1) continue;
          const file = line.slice(0, sep);
          const ln = line.slice(sep + 1, sep2);
          const match = line.slice(sep2 + 1);
          const cid = fileToId(cwd, file);
          (byId.get(cid) ?? byId.set(cid, []).get(cid)!).push(`L${ln}: ${clip(match.trim(), 200)}`);
        }
        const hits: string[] = [];
        for (const [cid, lines] of [...byId.entries()].sort())
          hits.push(`- ${cid}\n    ${lines.slice(0, 5).join("\n    ")}${lines.length > 5 ? `\n    …(+${lines.length - 5} more)` : ""}`);
        return {
          content: [{ type: "text", text: `# Matches (${byId.size} concepts)\n\n${hits.join("\n")}` }],
          details: {},
        };
      }

      // list
      const out: string[] = [];
      for await (const f of walk(root)) {
        const text = await readFile(f, "utf8").catch(() => "");
        const { fm } = splitFrontmatter(text);
        if (params.type && fmField(fm, "type") !== params.type) continue;
        if (params.tag && !fmTags(fm).includes(params.tag)) continue;
        if (params.status && fmField(fm, "status") !== params.status) continue;
        const cid = fileToId(cwd, f);
        const title = fmField(fm, "title") || cid;
        const desc = fmField(fm, "description") || "";
        const st = fmField(fm, "status");
        out.push(`- ${cid} — ${title}${desc ? `  (${desc})` : ""}${st ? `  [${st}]` : ""}`);
      }
      if (!out.length) return { content: [{ type: "text", text: "(no concepts)" }], details: {} };
      out.sort();
      return { content: [{ type: "text", text: `# Concepts (${out.length})\n\n${out.join("\n")}` }], details: {} };
    },
  });

  // ── 编: write (overwrite) or edit (exact patch) ──────────────────────
  pi.registerTool({
    name: "mem_put",
    label: "Memory · put",
    description:
      "Write or edit an OKF concept in the current project's bundle. " +
      "Edit mode (oldText+newText): exact substring replace within the existing concept (must match uniquely). " +
      "Write mode (no oldText): create or overwrite the concept; frontmatter is built from type/title/description/resource/tags/status/stale_after/sources, body is the markdown body. type is required for write.",
    promptSnippet: "Create/overwrite or patch OKF memory concepts for the current project.",
    promptGuidelines: [
      "Persist durable project knowledge (decisions, conventions, gotchas, entity docs) via mem_put; use edit mode for precise patches to long concepts.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Concept id (path rel bundle root, no .md). Leading @ stripped." }),
      // edit mode
      oldText: Type.Optional(Type.String({ description: "If set: exact substring to replace (edit mode)." })),
      newText: Type.Optional(Type.String({ description: "Replacement text (edit mode)." })),
      // write mode
      concept_type: Type.Optional(Type.String({ description: "OKF type, e.g. Note/Decision/Entity/Playbook (write mode)." })),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      resource: Type.Optional(Type.String({ description: "Canonical URI for the underlying asset (OKF §4.1)." })),
      tags: Type.Optional(Type.Array(Type.String())),
      status: Type.Optional(StringEnum(["current", "deprecated", "superseded"] as const, { description: "Lifecycle status (OKF §5)." })),
      stale_after: Type.Optional(Type.String({ description: "YYYY-MM-DD after which the concept may be stale (OKF §5)." })),
      sources: Type.Optional(
        Type.Array(Type.Object({ title: Type.Optional(Type.String()), resource: Type.String() })),
      ),
      body: Type.Optional(Type.String({ description: "Markdown body (write mode)." })),
    }),
    prepareArguments(args) {
      if (args && typeof args === "object" && args.conceptType !== undefined && args.concept_type === undefined)
        (args as Record<string, unknown>).concept_type = args.conceptType;
      return args;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const id = params.id.replace(/^@/, "");
      const ie = idErrors(id);
      if (ie.length)
        fail("", ie, `use a clean relative path like "notes/auth" — no leading "/", no ".."/"." segments, leaf name must not be "index" or "log".`);
      const file = idToFile(cwd, id);

      // edit mode
      if (params.oldText !== undefined) {
        if (params.newText === undefined)
          fail("edit", ["oldText was given but newText is missing"], `add newText with the replacement text; or drop BOTH oldText and newText and provide concept_type + body to overwrite the whole concept (write mode).`);
        if (!params.oldText)
          fail("edit", ["oldText is empty"], `call mem_get id="${id}" to read the current content, then copy the exact substring to replace into oldText.`);
        return withFileMutationQueue(file, async () => {
          const text = await readFile(file, "utf8").catch(() => null);
          if (text === null)
            fail("edit", [`concept "${id}" does not exist`], `to create it, drop oldText/newText and use write mode (concept_type + body); or call mem_get with no id to list concepts and pick the right id.`);
          if (!text.includes(params.oldText as string))
            fail("edit", [`oldText not found verbatim in "${id}"`], `call mem_get id="${id}" to read it, then copy the exact text into oldText (whitespace/indentation must match).`);
          await writeFile(file, text.replace(params.oldText as string, params.newText as string), "utf8");
          await gitAuto(bundleRoot(cwd), `edited ${id}`);
          return { content: [{ type: "text", text: `edited ${id}` }], details: {} };
        });
      }

      // write mode — aggregate all field errors before writing.
      const werr: string[] = [];
      if (!params.concept_type) werr.push("concept_type is missing");
      if (params.body === undefined) werr.push("body is missing");
      else if (!params.body.trim()) werr.push("body is empty");
      if (params.stale_after && !DATE_RE.test(params.stale_after))
        werr.push(`stale_after is ${JSON.stringify(params.stale_after)}, not YYYY-MM-DD`);
      if (params.sources)
        params.sources.forEach((s, i) => {
          if (!s.resource) werr.push(`sources[${i}].resource is empty`);
        });
      if (werr.length)
        fail(
          "write",
          werr,
          `provide concept_type (e.g. Note/Decision/Entity/Playbook) and a non-empty body; optional: title, description, resource (asset URI), tags, status (current/deprecated/superseded), stale_after (YYYY-MM-DD), sources[].resource (URL or bundle-relative path).`,
        );
      const doc = buildDoc({
        type: params.concept_type,
        title: params.title,
        description: params.description,
        resource: params.resource,
        tags: params.tags,
        status: params.status,
        stale_after: params.stale_after,
        sources: params.sources,
        body: params.body,
      });
      return withFileMutationQueue(file, async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, doc, "utf8");
        await gitAuto(bundleRoot(cwd), `wrote ${id}`);
        return { content: [{ type: "text", text: `wrote ${id} (${doc.length} bytes)` }], details: {} };
      });
    },
  });

  // ── 删: delete ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "mem_del",
    label: "Memory · delete",
    description: "Delete an OKF concept by id from the current project's bundle.",
    promptSnippet: "Delete an OKF memory concept.",
    parameters: Type.Object({
      id: Type.String({ description: "Concept id to delete. Leading @ stripped." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const id = params.id.replace(/^@/, "");
      const ie = idErrors(id);
      if (ie.length)
        throw new Error(`mem_del failed.\n  problems: ${ie.join("; ")}\n  fix: use a clean relative path like "notes/auth" — no "/"/".."/"." segments, leaf not "index"/"log".`);
      const file = idToFile(cwd, id);
      return withFileMutationQueue(file, async () => {
        const exists = await stat(file).then(() => true).catch(() => false);
        if (!exists)
          throw new Error(`mem_del failed.\n  problems: concept "${id}" not found.\n  fix: call mem_get with no id to list concepts and pick the right id.`);
        await unlink(file);
        await gitAuto(bundleRoot(cwd), `deleted ${id}`);
        // ponytail: no empty-dir cleanup; no index.md/log.md regen yet.
        return { content: [{ type: "text", text: `deleted ${id}` }], details: {} };
      });
    },
  });
}
