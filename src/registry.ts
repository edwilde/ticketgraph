import type Database from "better-sqlite3";
import { type GetClientRoots } from "./lib/roots.js";
import { makePingTool } from "./tools/ping.js";
import { makeRegisterProjectTool } from "./tools/register_project.js";
import { makeAddTool } from "./tools/add.js";
import { makeListTool } from "./tools/list.js";
import { makeGetTool } from "./tools/get.js";
import { makeStatsTool } from "./tools/stats.js";
import { makeUpdateTool } from "./tools/update.js";
import { makeLinkTool } from "./tools/link.js";
import { makeUnlinkTool } from "./tools/unlink.js";
import { makeSetParentTool } from "./tools/set_parent.js";
import { makeAppendToDescriptionTool } from "./tools/append_to_description.js";
import { makeAddTagTool } from "./tools/add_tag.js";
import { makeRemoveTagTool } from "./tools/remove_tag.js";
import { makeSearchTool } from "./tools/search.js";
import { makeNextTool } from "./tools/next.js";
import { makeRelatedTool } from "./tools/related.js";
import { makeBlockersOfTool } from "./tools/blockers_of.js";
import { makeChildrenOfTool } from "./tools/children_of.js";
import { makeChangedSinceTool } from "./tools/changed_since.js";
import { makeValidateTool } from "./tools/validate.js";
import { makeImportJsonTool } from "./tools/import_json.js";
import { makeAddManyTool } from "./tools/add_many.js";
import { makeExportTool } from "./tools/export.js";
import type { AnyTool } from "./tools/types.js";

export interface RegistryDeps {
  db: Database.Database;
  dbPath: string;
  getClientRoots: GetClientRoots;
}

export function makeToolRegistry(deps: RegistryDeps): Map<string, AnyTool> {
  const { db, getClientRoots } = deps;
  const tools: AnyTool[] = [
    makePingTool(deps) as unknown as AnyTool,
    makeRegisterProjectTool(db) as unknown as AnyTool,
    makeAddTool(db, getClientRoots) as unknown as AnyTool,
    makeAddManyTool(db, getClientRoots) as unknown as AnyTool,
    makeListTool(db, getClientRoots) as unknown as AnyTool,
    makeGetTool(db, getClientRoots) as unknown as AnyTool,
    makeStatsTool(db, getClientRoots) as unknown as AnyTool,
    makeUpdateTool(db, getClientRoots) as unknown as AnyTool,
    makeLinkTool(db, getClientRoots) as unknown as AnyTool,
    makeUnlinkTool(db, getClientRoots) as unknown as AnyTool,
    makeSetParentTool(db, getClientRoots) as unknown as AnyTool,
    makeAppendToDescriptionTool(db, getClientRoots) as unknown as AnyTool,
    makeAddTagTool(db, getClientRoots) as unknown as AnyTool,
    makeRemoveTagTool(db, getClientRoots) as unknown as AnyTool,
    makeSearchTool(db, getClientRoots) as unknown as AnyTool,
    makeNextTool(db, getClientRoots) as unknown as AnyTool,
    makeRelatedTool(db, getClientRoots) as unknown as AnyTool,
    makeBlockersOfTool(db, getClientRoots) as unknown as AnyTool,
    makeChildrenOfTool(db, getClientRoots) as unknown as AnyTool,
    makeChangedSinceTool(db, getClientRoots) as unknown as AnyTool,
    makeValidateTool(db, getClientRoots) as unknown as AnyTool,
    makeImportJsonTool(db, getClientRoots) as unknown as AnyTool,
    makeExportTool(db, getClientRoots) as unknown as AnyTool,
  ];
  return new Map(tools.map((t) => [t.name, t]));
}
