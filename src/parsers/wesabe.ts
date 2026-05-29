/**
 * Pure wesabe TICKETS.md parser.
 *
 * parseWesabe(md: string): ImportFile
 *
 * No file I/O. The CLI wrapper at the bottom reads from argv and writes stdout/stderr.
 */

import type { ImportFile, ImportTicket, ImportRelation } from "../lib/import-format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedTicket extends ImportTicket {
  _blockerRefs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an inline ship date to ISO 8601 format.
 * Returns null if no date found.
 */
function parseShipDate(text: string): string | null {
  const m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  return `${m[1]}T00:00:00.000Z`;
}

/**
 * Map inline status token (uppercase) to ImportTicket status value.
 */
function parseStatus(rawStatus: string | undefined): string {
  if (!rawStatus) return "open";
  const upper = rawStatus.trim().toUpperCase();
  if (upper === "DONE") return "done";
  if (upper === "DEFERRED") return "deferred";
  if (upper === "IN PROGRESS") return "in_progress";
  if (upper === "BLOCKED") return "blocked";
  return "open";
}

/**
 * Extract all NAMESPACE-NN refs from a string, deduped, in order of first appearance.
 */
function extractNamespacedRefs(text: string): string[] {
  const matches = text.match(/\b[A-Z]+-\d+\b/g);
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

// ---------------------------------------------------------------------------
// Parser report (captured during parse for --report output)
// ---------------------------------------------------------------------------

export interface ParseReport {
  tickets: number;
  relationsByKind: Record<string, number>;
  namespaceHistogram: Record<string, number>;
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a wesabe-format TICKETS.md string into an ImportFile.
 * Pure function — no I/O.
 */
export function parseWesabe(md: string): ImportFile {
  const { importFile } = parseWesabeWithReport(md);
  return importFile;
}

/**
 * Parse with a side-channel report for --report output.
 */
export function parseWesabeWithReport(md: string): {
  importFile: ImportFile;
  report: ParseReport;
} {
  const skipped: string[] = [];
  const tickets: ParsedTicket[] = [];

  // Heading regex: ### NS-NN: Title — STATUS (status optional)
  // Also handles compound IDs like DESIGN-01-01.
  const headingRe = /^### ([A-Z]+-\d+(?:-\d+)*): (.+?)(?: — (.+))?$/m;

  // Split into ## Epic sections. Each section starts at a ## heading.
  // We use a lookahead split so each part begins with its ## heading (or is preamble).
  const epicParts = md.split(/^(?=## )/m);

  for (const epicText of epicParts) {
    // Determine epic name from ## Epic N: Name or ## <free-form heading>
    // Match the full heading text after "## " (and optional "Epic N: " prefix),
    // then strip trailing " — ALL DONE" suffix.
    const epicHeaderMatch = epicText.match(/^## (.+)$/m);
    let epicName: string | null = null;
    if (epicHeaderMatch) {
      let raw = epicHeaderMatch[1]!.trim();
      // Remove "Epic N: " prefix if present
      raw = raw.replace(/^Epic \d+:\s*/, "");
      // Strip " — ALL DONE" suffix
      raw = raw.replace(/\s*—\s*ALL DONE\s*$/i, "").trim();
      epicName = raw || null;
    }

    // Split into ### NS-NN ticket blocks within this epic section.
    // Also handles compound IDs like DESIGN-01-01.
    const ticketParts = epicText.split(/^(?=### [A-Z]+-\d+(?:-\d+)*:)/m);

    for (const ticketText of ticketParts) {
      const headingMatch = ticketText.match(headingRe);
      if (!headingMatch) continue;

      const id = headingMatch[1]!;
      const title = headingMatch[2]!.trim();
      const rawStatus = headingMatch[3]; // may be undefined

      const status = parseStatus(rawStatus);

      // Namespace → type + tag
      const ns = id.split("-")[0]!;
      const type = ns === "BUG" ? "bug" : "task";
      const tags = [ns.toLowerCase()];

      // closed_at: parse inline date from heading status for done tickets
      let closed_at: string | null = null;
      if (status === "done" && rawStatus) {
        closed_at = parseShipDate(rawStatus);
      }

      // Blocked-by line: extract namespaced refs
      const blockedByMatch = ticketText.match(/^\s*-\s+\*\*Blocked by:\*\*(.*)$/m);
      const blockerRefs = blockedByMatch
        ? extractNamespacedRefs(blockedByMatch[1]!)
        : [];

      // Description: collect blockquote lines and bullet lines (except Blocked by).
      // ticketText starts with the ### heading line — skip it and collect the body.
      const descLines: string[] = [];
      const lines = ticketText.split("\n");
      // The first line is the heading; skip it.
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        // Blockquote lines
        if (/^>/.test(line)) {
          descLines.push(line);
          continue;
        }
        // Bullet lines — include all except Blocked by
        if (/^\s*-\s+/.test(line)) {
          if (/^\s*-\s+\*\*Blocked by:\*\*/.test(line)) continue;
          descLines.push(line);
          continue;
        }
      }

      // Trim trailing blank lines from description
      while (descLines.length > 0 && descLines[descLines.length - 1]!.trim() === "") {
        descLines.pop();
      }

      const description = descLines.length > 0 ? descLines.join("\n") : undefined;

      tickets.push({
        id,
        title,
        description,
        status,
        type,
        tags,
        epic: epicName ?? null,
        created_by: "migrated:wesabe",
        closed_at: closed_at ?? null,
        _blockerRefs: blockerRefs,
      });
    }
  }

  // --- Pass 2: resolve relations ---
  const relations: ImportRelation[] = [];

  for (const ticket of tickets) {
    for (const blockerRef of ticket._blockerRefs) {
      relations.push({ from: blockerRef, to: ticket.id, kind: "blocks", note: null });
    }
  }

  // Deduplicate relations by composite key.
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

  const namespaceHistogram: Record<string, number> = {};
  for (const ticket of tickets) {
    const ns = ticket.id.split("-")[0]!;
    namespaceHistogram[ns] = (namespaceHistogram[ns] ?? 0) + 1;
  }

  // Strip internal fields before returning.
  const cleanTickets: ImportTicket[] = tickets.map(({ _blockerRefs: _, ...rest }) => rest);

  const importFile: ImportFile = {
    project_id: "wesabe",
    tickets: cleanTickets,
    relations: dedupedRelations,
  };

  const report: ParseReport = {
    tickets: cleanTickets.length,
    relationsByKind,
    namespaceHistogram,
    skipped,
  };

  return { importFile, report };
}

// ---------------------------------------------------------------------------
// CLI entry — guarded so importing for tests does NOT trigger execution
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cliArgs = process.argv.slice(2);
  const reportFlag = cliArgs.includes("--report");
  const inputFile = cliArgs.find((a) => !a.startsWith("--"));

  if (!inputFile) {
    process.stderr.write("Usage: node dist/parsers/wesabe.js <input.md> [--report]\n");
    process.exit(1);
  }

  let content: string;
  try {
    const { readFileSync } = await import("node:fs");
    content = readFileSync(inputFile, "utf-8");
  } catch (err) {
    process.stderr.write(`Error reading file '${inputFile}': ${String(err)}\n`);
    process.exit(1);
  }

  const { importFile, report } = parseWesabeWithReport(content);

  process.stdout.write(JSON.stringify(importFile, null, 2) + "\n");

  if (reportFlag) {
    const relSummary = Object.entries(report.relationsByKind)
      .map(([kind, n]) => `  ${kind}: ${n}`)
      .join("\n");

    const nsSummary = Object.entries(report.namespaceHistogram)
      .sort(([, a], [, b]) => b - a)
      .map(([ns, n]) => `  ${ns}: ${n}`)
      .join("\n");

    process.stderr.write(
      [
        `--- wesabe parse report ---`,
        `Tickets parsed: ${report.tickets}`,
        `Relations by kind:`,
        relSummary || "  (none)",
        `Namespace histogram:`,
        nsSummary || "  (none)",
        report.skipped.length > 0
          ? `Skipped/ambiguous:\n${report.skipped.map((s) => `  ${s}`).join("\n")}`
          : `Skipped/ambiguous: 0`,
        `---`,
      ].join("\n") + "\n",
    );
  }
}
