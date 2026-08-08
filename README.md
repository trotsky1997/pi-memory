# pi-memory

OKF-backed project **memory** for [pi](https://github.com/earendil-works/pi-coding-agent).

Three tools expose a long-term, per-project knowledge store to the agent. Knowledge is stored as [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — plain markdown files with YAML frontmatter — one bundle per project, each auto-managed by git.

## Layout

```
~/.pi/memories/<escaped-cwd>/        # one OKF bundle per project
  .git/                               # auto-initialized, every mutation committed
  decisions/auth.md
  entities/user.md
  notes/deploy.md
  ...
```

`<escaped-cwd>` is `ctx.cwd` with `/` → `---` and other unsafe chars → `_`.
Example: `/root/myproject` → `root---myproject`.

## Tools

| tool | 意 | what it does |
|------|----|--------------|
| `mem_get` | 查 | `id` → read one concept raw; `query` → ripgrep regex search (case-insensitive) across frontmatter+body; neither → list all (optional `type`/`tag` filter) |
| `mem_put` | 编 | `oldText`+`newText` → exact patch; otherwise → create/overwrite a concept (frontmatter built from `type`/`title`/`description`/`tags`/`sources` + markdown `body`) |
| `mem_del` | 删 | delete a concept by id |

`mem_put` and `mem_del` auto-commit to the bundle's git repo:
- first mutation → `git init` + local `user.email/name` (`pi-memory@local` / `pi/memory`, repo-scoped only)
- every mutation → `git add -A && git commit -m "wrote/edited/deleted <id>"`
- git failures are swallowed (file op already succeeded; git is best-effort)

## OKF conformance

Every concept is a markdown file with YAML frontmatter. The only spec-required field is `type`. `mem_put` also writes `title` / `description` / `tags` / `generated` (by `pi/memory`, ISO timestamp) / `sources` when provided. Concepts link to each other via normal markdown links.

## Wiki links & automatic backlinks

Concepts form a bi-directional graph via Obsidian-style **wiki links**. Write `[[other-concept-id]]` (or `[[other-concept-id|alias]]`) anywhere in a concept's body to link to it.

```markdown
# notes/auth
Auth uses [[notes/oauth]] and [[notes/session|sessions]]. See also [[missing-thing]].
```

`mem_get` by id returns the raw markdown plus a computed **`## Linked concepts`** footer:

- **Forward links** — every `[[target]]` found in the body, marked `✓` if the target concept exists or `✗ (missing)` if it dangles.
- **Backlinks** — every other concept whose body links **to** this one (auto-computed, never stored).

Target boundaries are exact: `[[auth]]` does not match concept `auth2`, and `[[notes/auth]]` targets `notes/auth`, not `notes`. Backlinks are scanned across the whole bundle at read time — fine for a single-user store; add an index file if a bundle grows large enough that reads get slow.

## Install

```bash
pi install git:github.com/trotsky1997/pi-memory
```

## Configuration

Override the memory root (default `~/.pi/memories`) with:

```json
// ~/.pi/agent/settings.json
{ "env": { "PI_MEMORY_DIR": "/custom/path" } }
```

## License

MIT
