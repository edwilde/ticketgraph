/**
 * JSON intermediate format for ticket imports.
 *
 * Produced by parser tools (e.g. parseDemo) and consumed by tickets.import_json.
 * See docs/import-format.md for the full contract.
 */

const VALID_STATUSES = new Set(["open", "in_progress", "blocked", "done", "deferred"]);
const VALID_TYPES = new Set(["task", "bug", "spike", "followup", "umbrella"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const VALID_EFFORTS = new Set([1, 2, 3, 5, 8, 13]);
const VALID_KINDS = new Set(["blocks", "follows_up", "supersedes", "relates_to"]);

export interface ImportTicket {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string | null;
  type?: string;
  effort?: number | null;
  epic?: string | null;
  parent_id?: string | null;
  created_by?: string;
  created_at?: string;
  closed_at?: string | null;
  tags?: string[];
}

export interface ImportRelation {
  from: string;
  to: string;
  kind: string;
  note?: string | null;
}

export interface ImportFile {
  project_id: string;
  tickets: ImportTicket[];
  relations?: ImportRelation[];
}

/**
 * Runtime validator for an ImportFile parsed from JSON.
 * Throws a descriptive Error on any shape or value problem.
 * Used by both tickets.import_json and parser tests.
 */
export function validateImportFile(raw: unknown): ImportFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Import file must be a JSON object.");
  }
  const r = raw as Record<string, unknown>;

  // project_id
  if (typeof r["project_id"] !== "string" || r["project_id"].trim().length === 0) {
    throw new Error("project_id must be a non-empty string.");
  }
  const project_id = r["project_id"] as string;

  // tickets
  if (!Array.isArray(r["tickets"])) {
    throw new Error("tickets must be an array.");
  }
  const tickets: ImportTicket[] = (r["tickets"] as unknown[]).map((t, i) => {
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      throw new Error(`tickets[${i}] must be an object.`);
    }
    const tk = t as Record<string, unknown>;

    if (typeof tk["id"] !== "string" || tk["id"].trim().length === 0) {
      throw new Error(`tickets[${i}].id must be a non-empty string.`);
    }
    if (typeof tk["title"] !== "string" || tk["title"].trim().length === 0) {
      throw new Error(`tickets[${i}].title must be a non-empty string.`);
    }

    const status = tk["status"];
    if (status !== undefined && (typeof status !== "string" || !VALID_STATUSES.has(status as string))) {
      throw new Error(
        `tickets[${i}].status must be one of: ${[...VALID_STATUSES].join(", ")} (got ${JSON.stringify(status)}).`,
      );
    }

    const type = tk["type"];
    if (type !== undefined && (typeof type !== "string" || !VALID_TYPES.has(type as string))) {
      throw new Error(
        `tickets[${i}].type must be one of: ${[...VALID_TYPES].join(", ")} (got ${JSON.stringify(type)}).`,
      );
    }

    const priority = tk["priority"];
    if (
      priority !== undefined &&
      priority !== null &&
      (typeof priority !== "string" || !VALID_PRIORITIES.has(priority as string))
    ) {
      throw new Error(
        `tickets[${i}].priority must be null or one of: ${[...VALID_PRIORITIES].join(", ")} (got ${JSON.stringify(priority)}).`,
      );
    }

    const effort = tk["effort"];
    if (
      effort !== undefined &&
      effort !== null &&
      (typeof effort !== "number" || !VALID_EFFORTS.has(effort as number))
    ) {
      throw new Error(
        `tickets[${i}].effort must be null or one of: ${[...VALID_EFFORTS].join(", ")} (got ${JSON.stringify(effort)}).`,
      );
    }

    const description = tk["description"];
    if (description !== undefined && typeof description !== "string") {
      throw new Error(`tickets[${i}].description must be a string when present.`);
    }

    const created_at = tk["created_at"];
    if (created_at !== undefined && typeof created_at !== "string") {
      throw new Error(`tickets[${i}].created_at must be an ISO 8601 string when present.`);
    }
    if (typeof created_at === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(created_at)) {
      throw new Error(
        `tickets[${i}].created_at must be ISO 8601 format (got ${JSON.stringify(created_at)}).`,
      );
    }

    const closed_at = tk["closed_at"];
    if (closed_at !== undefined && closed_at !== null && typeof closed_at !== "string") {
      throw new Error(`tickets[${i}].closed_at must be null or an ISO 8601 string when present.`);
    }
    if (typeof closed_at === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(closed_at)) {
      throw new Error(
        `tickets[${i}].closed_at must be ISO 8601 format (got ${JSON.stringify(closed_at)}).`,
      );
    }

    const tags = tk["tags"];
    if (tags !== undefined && !Array.isArray(tags)) {
      throw new Error(`tickets[${i}].tags must be an array when present.`);
    }
    if (Array.isArray(tags) && tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`tickets[${i}].tags must be an array of strings.`);
    }

    return {
      id: tk["id"] as string,
      title: tk["title"] as string,
      ...(description !== undefined ? { description: description as string } : {}),
      ...(status !== undefined ? { status: status as string } : {}),
      ...(priority !== undefined ? { priority: priority as string | null } : {}),
      ...(type !== undefined ? { type: type as string } : {}),
      ...(effort !== undefined ? { effort: effort as number | null } : {}),
      ...(tk["epic"] !== undefined ? { epic: tk["epic"] as string | null } : {}),
      ...(tk["parent_id"] !== undefined ? { parent_id: tk["parent_id"] as string | null } : {}),
      ...(tk["created_by"] !== undefined ? { created_by: tk["created_by"] as string } : {}),
      ...(created_at !== undefined ? { created_at: created_at as string } : {}),
      ...(closed_at !== undefined ? { closed_at: closed_at as string | null } : {}),
      ...(tags !== undefined ? { tags: tags as string[] } : {}),
    };
  });

  // relations (optional)
  const rawRelations = r["relations"];
  let relations: ImportRelation[] | undefined;
  if (rawRelations !== undefined) {
    if (!Array.isArray(rawRelations)) {
      throw new Error("relations must be an array when present.");
    }
    relations = (rawRelations as unknown[]).map((rel, i) => {
      if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
        throw new Error(`relations[${i}] must be an object.`);
      }
      const rv = rel as Record<string, unknown>;

      if (typeof rv["from"] !== "string" || rv["from"].trim().length === 0) {
        throw new Error(`relations[${i}].from must be a non-empty string.`);
      }
      if (typeof rv["to"] !== "string" || rv["to"].trim().length === 0) {
        throw new Error(`relations[${i}].to must be a non-empty string.`);
      }
      if (typeof rv["kind"] !== "string" || !VALID_KINDS.has(rv["kind"] as string)) {
        throw new Error(
          `relations[${i}].kind must be one of: ${[...VALID_KINDS].join(", ")} (got ${JSON.stringify(rv["kind"])}).`,
        );
      }

      return {
        from: rv["from"] as string,
        to: rv["to"] as string,
        kind: rv["kind"] as string,
        ...(rv["note"] !== undefined ? { note: rv["note"] as string | null } : {}),
      };
    });
  }

  return {
    project_id,
    tickets,
    ...(relations !== undefined ? { relations } : {}),
  };
}
