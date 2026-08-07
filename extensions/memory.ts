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

const MEM_ROOT = resolve(process.env.HOME || "", ".pi/memories");

// '/' → '---', other unsafe chars → '_'. Human-readable & reversible-ish.
// e.g. /root/myproject → root---myproject.
function escapeCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return (parts.join("---").replace(/[^a-zA-Z0-9._-]+/g, "_") || "_root");
}
const bundleRoot = (cwd: string) => join(MEM_ROOT, escapeCwd(cwd));
const idToFile = (cwd: string, id: string) => join(bundleRoot(cwd), id.replace(/^\/+/, "")) + ".md";
const fileToId = (cwd: string, file: string) => relative(bundleRoot(cwd), file).replace(/\.md$/i, "");

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

// Return a structured, actionable error as the tool result so the agent reads it verbatim.
// (Returned errors are reported in the tool result text; the agent self-corrects from it.)
const TYPE = "text" as const;
function fail(mode: string, problems: string[], fix: string) {
  const msg =
    `mem_put${mode ? ` (${mode})` : ""} failed.\n` +
    `  problems: ${problems.join("; ")}\n` +
    `  fix: ${fix}`;
  return { content: [{ type: TYPE, text: msg }], details: {} };
}

// Auto-git each bundle: init on first use, then add+commit every mutation.
// ponytail: per-file queue only serializes same-file git; cross-file concurrent
// commits may race (last write wins the tree). Fine for a single-user memory store;
// add a bundle-level mutex if contention shows up.
async function gitAuto(root: string, message: string): Promise<void> {
  try {
    if (!existsSync(join(root, ".git"))) {
      await exec(`git init -q ${JSON.stringify(root)}`);
      await exec(`git -C ${JSON.stringify(root)} config user.email pi-memory@local`);
      await exec(`git -C ${JSON.stringify(root)} config user.name "pi/memory"`);
    }
    await exec(`git -C ${JSON.stringify(root)} add -A`);
    await exec(`git -C ${JSON.stringify(root)} commit -q -m ${JSON.stringify(message)}`);
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

  // ── 查: list / search / read ────────────────────────────────────────
  pi.registerTool({
    name: "mem_get",
    label: "Memory · get",
    description:
      "Read the OKF memory bundle for the current project (~/.pi/memories/<project>/). " +
      "If id is given → return that concept's raw markdown. Else if query is given → ripgrep search (query is an rg regex, case-insensitive) across frontmatter+body, return matching ids + line:snippet. " +
      "Else → list all concepts (id + title), optionally filtered by type/tag/status. " +
      "Concept id = file path rel bundle root without .md (e.g. 'notes/auth'). Leading @ stripped.",
    promptSnippet: "List / search / read OKF memory concepts for the current project.",
    promptGuidelines: [
      "Before re-deriving project knowledge (decisions, conventions, entity docs), call mem_get to recall what's already persisted.",
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

      // read one
      if (params.id) {
        const id = params.id.replace(/^@/, "");
        const ie = idErrors(id);
        if (ie.length)
          return { content: [{ type: TYPE, text: `mem_get failed.\n  problems: ${ie.join("; ")}\n  fix: use a clean relative path like "notes/auth" — no "/"/".."/"." segments, leaf not "index"/"log".` }], details: {} };
        const text = await readFile(idToFile(cwd, id), "utf8").catch(() => null);
        if (text === null)
          return { content: [{ type: TYPE, text: `mem_get failed.\n  problems: concept "${id}" not found.\n  fix: call mem_get with no id to list all concepts, or check the id spelling.` }], details: {} };
        return { content: [{ type: "text", text }], details: {} };
      }

      // search — query is an rg regex, case-insensitive.
      // ponytail: shells out to ripgrep; no JS fallback. rg required at runtime.
      if (params.query) {
        let stdout = "";
        try {
          const { stdout: out } = await exec(
            `rg -i -n --no-heading -- ${JSON.stringify(params.query)} ${JSON.stringify(root)}`,
            { maxBuffer: 4 * 1024 * 1024 },
          );
          stdout = out;
        } catch (e: unknown) {
          // rg exits 1 on no matches
          if ((e as { code?: number }).code === 1)
            return { content: [{ type: "text", text: `(no matches for /${params.query}/)` }], details: {} };
          return { content: [{ type: TYPE, text: `mem_get (search) failed.\n  problems: ripgrep error — ${String((e as Error).message || e)}\n  fix: check that the query is a valid regex; rg is required at runtime.` }], details: {} };
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
        return fail("", ie, `use a clean relative path like "notes/auth" — no leading "/", no ".."/"." segments, leaf name must not be "index" or "log".`);
      const file = idToFile(cwd, id);

      // edit mode
      if (params.oldText !== undefined) {
        if (params.newText === undefined)
          return fail("edit", ["oldText was given but newText is missing"], `add newText with the replacement text; or drop BOTH oldText and newText and provide concept_type + body to overwrite the whole concept (write mode).`);
        if (!params.oldText)
          return fail("edit", ["oldText is empty"], `call mem_get id="${id}" to read the current content, then copy the exact substring to replace into oldText.`);
        return withFileMutationQueue(file, async () => {
          const text = await readFile(file, "utf8").catch(() => null);
          if (text === null)
            return fail("edit", [`concept "${id}" does not exist`], `to create it, drop oldText/newText and use write mode (concept_type + body); or call mem_get with no id to list concepts and pick the right id.`);
          if (!text.includes(params.oldText as string))
            return fail("edit", [`oldText not found verbatim in "${id}"`], `call mem_get id="${id}" to read it, then copy the exact text into oldText (whitespace/indentation must match).`);
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
        return fail(
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
        return { content: [{ type: TYPE, text: `mem_del failed.\n  problems: ${ie.join("; ")}\n  fix: use a clean relative path like "notes/auth" — no "/"/".."/"." segments, leaf not "index"/"log".` }], details: {} };
      const file = idToFile(cwd, id);
      return withFileMutationQueue(file, async () => {
        const exists = await stat(file).then(() => true).catch(() => false);
        if (!exists)
          return { content: [{ type: TYPE, text: `mem_del failed.\n  problems: concept "${id}" not found.\n  fix: call mem_get with no id to list concepts and pick the right id.` }], details: {} };
        await unlink(file);
        await gitAuto(bundleRoot(cwd), `deleted ${id}`);
        // ponytail: no empty-dir cleanup; no index.md/log.md regen yet.
        return { content: [{ type: "text", text: `deleted ${id}` }], details: {} };
      });
    },
  });
}
