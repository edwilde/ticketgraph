# Migrating from TICKETS.md to ticketgraph

This guide is for people who have a flat `.ai/TICKETS.md` file in one or more projects and want to move that data into ticketgraph.

---

## The model

**ticketgraph becomes the canonical store.** Once you migrate, the database is the source of truth for ticket state. TICKETS.md is migrated once and then deleted; it is never re-ingested. If you want a read-only markdown view afterwards, `tickets.export` can regenerate a snapshot with a loud generated-at banner (see [docs/usage.md](usage.md)).

The migration is a one-time operation:

1. Parse TICKETS.md into the JSON intermediate format.
2. Import the JSON into ticketgraph.
3. Verify the import looks correct.
4. Delete the old TICKETS.md.

After step 4, Claude reads from the MCP tools instead of reading the file. That is the token saving.

---

## Prerequisites

- ticketgraph installed and the MCP server registered (see [docs/install.md](install.md)).
- The target project registered in ticketgraph:
  ```json
  tickets.register_project({
    "id": "myproject",
    "display_name": "My Project",
    "root_path": "/absolute/path/to/myproject"
  })
  ```

---

## Step 1: parse TICKETS.md to JSON

`TICKETS.md` files vary too much to auto-detect, so migration goes through a JSON intermediate: you write a small parser that turns your file into that shape, and `tickets.import_json` ingests it.

The contract is the `ImportFile` type: a `project_id` string, a `tickets` array, and an optional `relations` array. See [docs/import-format.md](import-format.md) for the full schema.

Keep the parser a pure function `(md: string) => ImportFile` with file I/O in a thin CLI wrapper, so it stays unit-testable against fixture strings. A typical invocation writes the JSON intermediate to stdout:

```sh
node my-parser.js /path/to/project/.ai/TICKETS.md > /tmp/myproject.json
```

The JSON intermediate is the only contract between your parser and `tickets.import_json`; there is no auto-detection of arbitrary formats.

---

## Step 2: dry run

Before writing anything to the database, validate the file and inspect the counts:

```json
tickets.import_json({
  "project": "myproject",
  "file": "/tmp/myproject.json",
  "dry_run": true
})
```

Response shape:

```json
{
  "dry_run": true,
  "counts": { "tickets": 133, "relations": 94, "tags": 0 },
  "warnings": []
}
```

Check:
- `counts.tickets` matches what you expect from the source file.
- `warnings` is empty or contains only expected notices (e.g. dangling relations for tickets that reference IDs not in the file).

If warnings list ticket IDs you don't recognise, inspect the source file and the parser's `--report` output before proceeding.

---

## Step 3: live import

Once the dry run looks correct, run the live import:

```json
tickets.import_json({
  "project": "myproject",
  "file": "/tmp/myproject.json"
})
```

The import runs in a single transaction with three passes:

1. All tickets are inserted (with `parent_id = NULL`).
2. `parent_id` links are set (forward references are safe because all tickets exist by this point).
3. Valid relations are inserted; dangling ones (missing endpoint) are skipped with a warning and do not abort the import.

Response includes `imported: true`, final counts, and any warnings from the live run.

If you have already run a partial import and need to overwrite it, pass `force: true`. Colliding tickets are deleted first (cascading their relations and tags) before the fresh data is inserted:

```json
tickets.import_json({
  "project": "myproject",
  "file": "/tmp/myproject.json",
  "force": true
})
```

---

## Step 4: verify

Run a few spot-checks in Claude Code:

```json
tickets.stats({})
```

Confirm the counts match your expectations. Then fetch a specific ticket you know well:

```json
tickets.get({ "id": "T1" })
```

Check that the title, description, status, and relations look right.

Run the integrity checker to confirm there are no orphan parents or dangling relations:

```json
tickets.validate({})
```

`ok: true` means no error-severity issues were found.

---

## Step 5: delete TICKETS.md

Once you are satisfied the import is correct:

```sh
rm /path/to/project/.ai/TICKETS.md
```

From this point, Claude reads ticket state from the MCP tools. There is no TICKETS.md to keep in sync.

---

## Re-importing

If you need to re-import (e.g. after discovering a parser bug), re-run the parser, dry-run again, then import with `force: true` to overwrite the existing data for that project.
