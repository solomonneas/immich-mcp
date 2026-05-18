import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid } from "../types.js";
import { asMcpResponse, asMcpError, surfaceError, requireWrites, requireConfirm } from "./_util.js";

export function registerPeopleTools(server: McpServer, config: Config): void {
  server.tool("immich_list_people", "List recognized people.", {
    page: z.number().int().min(1).optional(),
    size: z.number().int().min(1).max(1000).optional(),
    withHidden: z.boolean().optional(),
  }, async (args) => {
    try { return asMcpResponse(await sdk.getAllPeople(args)); }
    catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_get_person", "Get one person. Falls back to person statistics if direct get is unavailable.", {
    id: Uuid,
  }, async ({ id }) => {
    try {
      const sdkAny = sdk as unknown as { getPerson?: (a: { id: string }) => Promise<unknown> };
      if (typeof sdkAny.getPerson === "function") {
        return asMcpResponse(await sdkAny.getPerson({ id }));
      }
      const stats = await sdk.getPersonStatistics({ id });
      return asMcpResponse({ id, statistics: stats });
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_get_person_assets", "List assets for a given person.", {
    id: Uuid,
    size: z.number().int().min(1).max(1000).optional(),
    page: z.number().int().min(1).optional(),
  }, async ({ id, size, page }) => {
    try {
      return asMcpResponse(await sdk.searchAssets({ metadataSearchDto: { personIds: [id], size, page } as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_update_person", "Update person name, birthdate, visibility, favorite, feature face.", {
    id: Uuid,
    name: z.string().optional(),
    birthDate: z.string().optional(),
    isHidden: z.boolean().optional(),
    isFavorite: z.boolean().optional(),
    featureFaceAssetId: Uuid.optional(),
  }, async ({ id, ...rest }) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.updatePerson({ id, personUpdateDto: rest as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_hide_person", "Convenience: hide a person from default lists.", { id: Uuid }, async ({ id }) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.updatePerson({ id, personUpdateDto: { isHidden: true } as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_merge_people", "Merge other people into a target. Requires confirm: true.", {
    id: Uuid,
    ids: z.array(Uuid).min(1).max(50),
    confirm: z.boolean().optional(),
  }, async ({ id, ids, confirm }) => {
    try {
      requireWrites(config);
      requireConfirm("immich_merge_people", confirm);
      return asMcpResponse(await sdk.mergePerson({ id, mergePersonDto: { ids } as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });
}
