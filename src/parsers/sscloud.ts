/**
 * Pure sscloud TICKETS.md parser.
 *
 * parseSscloud(md: string): ImportFile
 *
 * No file I/O. The CLI wrapper at the bottom reads from argv and writes stdout/stderr.
 */

import type { ImportFile, ImportTicket, ImportRelation } from "../lib/import-format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedTicket extends ImportTicket {
  _blockerRefs: string[];
  _rawStatusLine: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all T<n> token references from a string, deduped, in order of first appearance.
 * Ignores "none" sentinel.
 */
function extractTicketRefs(text: string): string[] {
  if (/\bnone\b/i.test(text)) return [];
  const matches = text.match(/\bT\d+\b/g);
  if (!matches) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      result.push(m);
    }
  }
  return result;
}

/**
 * Expand explicit numeric ranges like T112-T119 into individual refs T112..T119.
 * Only matches the form T<n>-T<m> where both are the same prefix "T".
 */
function expandRanges(text: string): string {
  return text.replace(/\bT(\d+)-T(\d+)\b/g, (_, startStr: string, endStr: string) => {
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (start >= end || end - start > 50) return `T${startStr}-T${endStr}`;
    const refs: string[] = [];
    for (let i = start; i <= end; i++) refs.push(`T${i}`);
    return refs.join(", ");
  });
}

/**
 * Normalise an inline ship date to ISO 8601 format (YYYY-MM-DDTHH:MM:SS.sssZ).
 * Returns null if no date found.
 * Patterns: "2026-05-27", "2026-05-27T..." etc.
 */
function parseShipDate(text: string): string | null {
  const m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  return `${m[1]}T00:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// Parser report (captured during parse for --report output)
// ---------------------------------------------------------------------------

export interface ParseReport {
  tickets: number;
  relationsByKind: Record<string, number>;
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a sscloud-format TICKETS.md string into an ImportFile.
 * Pure function — no I/O.
 */
export function parseSscloud(md: string): ImportFile {
  const { importFile } = parseSscloudWithReport(md);
  return importFile;
}

/**
 * Parse with a side-channel report for --report output.
 */
export function parseSscloudWithReport(md: string): {
  importFile: ImportFile;
  report: ParseReport;
} {
  const skipped: string[] = [];
  const tickets: ParsedTicket[] = [];

  // Expand ranges before processing to simplify downstream matching.
  const expandedMd = expandRanges(md);

  // Split into ## P<n> sections (priority/epic blocks).
  // A section starts at ## P<n> and continues until the next ## P<n> or end.
  const sectionPattern = /^## (P[0-3]) — (.+)$/m;
  const sectionParts = expandedMd.split(/^(?=## P[0-3] — )/m);

  for (const sectionText of sectionParts) {
    // Determine priority + epic for this section.
    const sectionHeader = sectionText.match(/^## (P[0-3]) — (.+)$/m);
    const priority: string | null = sectionHeader ? sectionHeader[1]! : null;
    const epic: string | null = sectionHeader
      ? sectionHeader[2]!.trim()
      : null;

    // Split into ### T<n> ticket blocks within this section.
    // Handles suffixed ids: T50a, T49-followup, T36-fixup-1, T87b, etc.
    const ticketParts = sectionText.split(/^(?=### T\d+)/m);

    for (const ticketText of ticketParts) {
      const headingMatch = ticketText.match(/^### (T\d+[\w-]*) — (.+)$/m);
      if (!headingMatch) continue;

      const id = headingMatch[1]!;
      const title = headingMatch[2]!.trim();

      // --- Status ---
      const statusLineMatch = ticketText.match(/^\*\*Status:\*\*(.*)$/m);
      const rawStatusLine = statusLineMatch ? statusLineMatch[1]!.trim() : "";

      let status: string;
      if (!rawStatusLine) {
        status = "open";
      } else if (/✅|Done\b/.test(rawStatusLine) || /\bShipped\b/.test(rawStatusLine) || /\bSuperseded\b/i.test(rawStatusLine)) {
        status = "done";
      } else if (/In progress/i.test(rawStatusLine)) {
        status = "in_progress";
      } else if (/Deferred/i.test(rawStatusLine)) {
        status = "deferred";
      } else if (/Blocked\b/i.test(rawStatusLine)) {
        status = "blocked";
      } else {
        // "Open" or "Open." or any explicit open marker
        status = "open";
      }

      // --- closed_at from inline date ---
      let closed_at: string | null = null;
      if (status === "done" && rawStatusLine) {
        closed_at = parseShipDate(rawStatusLine);
      }

      // --- Blockers line ---
      const blockersLineMatch = ticketText.match(/^\*\*Blockers:\*\*(.*)$/m);
      const blockersText = blockersLineMatch ? blockersLineMatch[1]!.trim() : "";
      const blockerRefs = extractTicketRefs(blockersText);

      // --- Description from Scope + Acceptance ---
      let description = "";
      const scopeMatch = ticketText.match(/^\*\*Scope:\*\*(.+?)(?=^\*\*Acceptance:\*\*|^\*\*Blockers:\*\*|^---\s*$|^### T\d+|^## P)/ms);
      const acceptanceMatch = ticketText.match(/^\*\*Acceptance:\*\*(.+?)(?=^---\s*$|^### T\d+|^## P|$)/ms);

      const scopePart = scopeMatch ? `**Scope:**${scopeMatch[1]}`.trimEnd() : "";
      const acceptancePart = acceptanceMatch
        ? `**Acceptance:**${acceptanceMatch[1]}`.trimEnd()
        : "";

      if (scopePart && acceptancePart) {
        description = `${scopePart}\n\n${acceptancePart}`;
      } else if (scopePart) {
        description = scopePart;
      } else if (acceptancePart) {
        description = acceptancePart;
      }

      tickets.push({
        id,
        title,
        description: description || undefined,
        status,
        priority,
        epic,
        created_by: "migrated:sscloud",
        closed_at,
        _blockerRefs: blockerRefs,
        _rawStatusLine: rawStatusLine,
      });
    }
  }

  // --- Also parse tickets NOT inside any ## P<n> section ---
  // (tickets at top level before any ## section, unlikely but safe)

  // --- Pass 2: resolve relations ---
  const relations: ImportRelation[] = [];
  const ticketIds = new Set(tickets.map((t) => t.id));

  for (const ticket of tickets) {
    // blocks relations from **Blockers:** line.
    for (const blockerRef of ticket._blockerRefs) {
      relations.push({ from: blockerRef, to: ticket.id, kind: "blocks" });
    }

    // supersedes + follows_up from **Status:** line.
    const rawStatus = ticket._rawStatusLine;

    // superseded by T<n>
    const supersededBy = rawStatus.match(/[Ss]uperseded by (T\d+)/);
    if (supersededBy) {
      // ticket supersedes the old one
      relations.push({ from: ticket.id, to: supersededBy[1]!, kind: "supersedes" });
    }

    // Tracked as T<n> → follows_up relation (this ticket follows up on T<n>)
    const trackedAs = rawStatus.match(/Tracked as (T\d+)/);
    if (trackedAs) {
      relations.push({ from: ticket.id, to: trackedAs[1]!, kind: "follows_up" });
    }
  }

  // Deduplicate relations by composite key (from, to, kind).
  const relMap = new Map<string, ImportRelation>();
  for (const rel of relations) {
    const key = `${rel.from}|${rel.to}|${rel.kind}`;
    if (!relMap.has(key)) {
      relMap.set(key, rel);
    }
  }
  const dedupedRelations = [...relMap.values()];

  // Build report.
  const relationsByKind: Record<string, number> = {};
  for (const rel of dedupedRelations) {
    relationsByKind[rel.kind] = (relationsByKind[rel.kind] ?? 0) + 1;
  }

  // Strip internal fields from tickets before returning.
  const cleanTickets: ImportTicket[] = tickets.map(({ _blockerRefs: _, _rawStatusLine: __, ...rest }) => rest);

  const importFile: ImportFile = {
    project_id: "sscloud",
    tickets: cleanTickets,
    relations: dedupedRelations,
  };

  const report: ParseReport = {
    tickets: cleanTickets.length,
    relationsByKind,
    skipped,
  };

  return { importFile, report };
}

// ---------------------------------------------------------------------------
// CLI entry — guarded so importing for tests does NOT trigger execution
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Read argv.
  const cliArgs = process.argv.slice(2);
  const reportFlag = cliArgs.includes("--report");
  const inputFile = cliArgs.find((a) => !a.startsWith("--"));

  if (!inputFile) {
    process.stderr.write(
      "Usage: node dist/parsers/sscloud.js <input.md> [--report]\n",
    );
    process.exit(1);
  }

  // Read file.
  let content: string;
  try {
    const { readFileSync } = await import("node:fs");
    content = readFileSync(inputFile, "utf-8");
  } catch (err) {
    process.stderr.write(`Error reading file '${inputFile}': ${String(err)}\n`);
    process.exit(1);
  }

  const { importFile, report } = parseSscloudWithReport(content);

  process.stdout.write(JSON.stringify(importFile, null, 2) + "\n");

  if (reportFlag) {
    const relSummary = Object.entries(report.relationsByKind)
      .map(([kind, n]) => `  ${kind}: ${n}`)
      .join("\n");

    process.stderr.write(
      [
        `--- sscloud parse report ---`,
        `Tickets parsed: ${report.tickets}`,
        `Relations by kind:`,
        relSummary || "  (none)",
        report.skipped.length > 0
          ? `Skipped/ambiguous:\n${report.skipped.map((s) => `  ${s}`).join("\n")}`
          : `Skipped/ambiguous: 0`,
        `---`,
      ].join("\n") + "\n",
    );
  }
}
