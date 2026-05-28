# ticketgraph JSON Import Format

The JSON intermediate format is the contract between source-specific parsers (e.g. the sscloud
parser) and the generic `tickets.import_json` MCP tool.

## Schema

```json
{
  "project_id": "sscloud",
  "tickets": [...],
  "relations": [...]
}
```

### Top-level fields

| Field        | Type   | Required | Description                                          |
|--------------|--------|----------|------------------------------------------------------|
| `project_id` | string | yes      | Must match a registered project and the `project` arg passed to `tickets.import_json`. |
| `tickets`    | array  | yes      | Array of ticket objects (see below).                 |
| `relations`  | array  | no       | Array of relation objects (see below). Omit or `[]` for none. |

### Ticket object

| Field        | Type              | Required | Default   | Allowed values                                        |
|--------------|-------------------|----------|-----------|-------------------------------------------------------|
| `id`         | string            | yes      | —         | Any non-empty string unique within the project.       |
| `title`      | string            | yes      | —         | Non-empty string.                                     |
| `description`| string            | no       | `""`      | Free text.                                            |
| `status`     | string            | no       | `"open"`  | `open`, `in_progress`, `blocked`, `done`, `deferred`  |
| `priority`   | string \| null    | no       | `null`    | `P0`, `P1`, `P2`, `P3`, or `null`                    |
| `type`       | string            | no       | `"task"`  | `task`, `bug`, `spike`, `followup`, `umbrella`        |
| `effort`     | number \| null    | no       | `null`    | `1`, `2`, `3`, `5`, `8`, `13`, or `null`             |
| `epic`       | string \| null    | no       | `null`    | Free text grouping label.                             |
| `parent_id`  | string \| null    | no       | `null`    | Id of a parent ticket in the same project.            |
| `created_by` | string            | no       | `"claude"`| Creator identifier (e.g. `"migrated:sscloud"`).      |
| `created_at` | string (ISO 8601) | no       | import time | Must be `YYYY-MM-DDTHH:MM:SS.sssZ` format.        |
| `closed_at`  | string \| null    | no       | `null`    | ISO 8601. Set when status is `done`/`deferred`.       |
| `tags`       | string[]          | no       | `[]`      | Tags (stored lowercase-trimmed).                     |

### Relation object

| Field  | Type   | Required | Allowed values                                |
|--------|--------|----------|-----------------------------------------------|
| `from` | string | yes      | Ticket id.                                    |
| `to`   | string | yes      | Ticket id.                                    |
| `kind` | string | yes      | `blocks`, `follows_up`, `supersedes`, `relates_to` |
| `note` | string \| null | no | Optional one-line context.              |

## 3-pass transactional write

`tickets.import_json` writes all data in a **single transaction** using three passes, so forward
references (a child ticket listed before its parent) are safe:

1. **Pass 1 — insert tickets**: all tickets are inserted with `parent_id = NULL`. Tags are
   inserted alongside each ticket. A back-dated `_created` audit row is written with
   `changed_at = created_at` (preserving history for `tickets.changed_since`).

2. **Pass 2 — update parent_id**: tickets that had a `parent_id` get it set. By this point all
   tickets exist, so foreign-key constraints are satisfied regardless of file order.

3. **Pass 3 — insert relations**: relations whose both endpoints exist (in the file or already in
   the DB) are inserted. Dangling relations (missing endpoint) are skipped and logged as warnings
   — they do not abort the import.

## dry_run

Pass `dry_run: true` to validate the file and compute counts/warnings without writing anything:

```json
{
  "dry_run": true,
  "counts": { "tickets": 133, "relations": 94, "tags": 0 },
  "warnings": ["Duplicate ticket ids (already in DB): T1, T2"]
}
```

## force

By default, duplicate `(project_id, id)` collisions abort the import. Pass `force: true` to
overwrite: the colliding tickets are `DELETE`d first (cascading their relations and tags), then
the fresh data is inserted.

## Typical migration flow

```bash
# 1. Parse the source file into JSON intermediate
node dist/parsers/sscloud.js ~/Scripts/sscloud/.ai/TICKETS.md --report > /tmp/sscloud.json

# 2. Dry-run: validate and inspect counts/warnings
# Use tickets.import_json({ project: "sscloud", file: "/tmp/sscloud.json", dry_run: true })

# 3. Live import
# Use tickets.import_json({ project: "sscloud", file: "/tmp/sscloud.json" })
```

## sscloud parser

The sscloud parser (`src/parsers/sscloud.ts`) converts a sscloud-format `TICKETS.md` to this
intermediate. It is a pure function: `parseSscloud(md: string): ImportFile`.

CLI usage:

```bash
node dist/parsers/sscloud.js <input.md> [--report]
```

- Writes JSON to stdout.
- `--report` writes a parse summary (ticket count, relation counts by kind, skipped/ambiguous
  lines) to stderr.
