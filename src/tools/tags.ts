import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid, BulkIds } from "../types.js";
import { asMcpResponse, asMcpError, surfaceError, requireWrites, requireConfirm } from "./_util.js";

export function registerTagTools(server: McpServer, config: Config): void {
  server.tool("immich_list_tags", "List all tags.", {}, async () => {
    try { return asMcpResponse(await sdk.getAllTags()); }
    catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_get_tag", "Get one tag.", { id: Uuid }, async ({ id }) => {
    try { return asMcpResponse(await sdk.getTagById({ id })); }
    catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_create_tag", "Create a tag.", {
    name: z.string().min(1),
    color: z.string().optional(),
    parentId: Uuid.optional(),
  }, async (args) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.createTag({ tagCreateDto: args as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_update_tag", "Rename or recolor a tag.", {
    id: Uuid,
    name: z.string().optional(),
    color: z.string().optional(),
  }, async ({ id, ...rest }) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.updateTag({ id, tagUpdateDto: rest as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_delete_tag", "Delete a tag. Requires confirm: true.", {
    id: Uuid,
    confirm: z.boolean().optional(),
  }, async ({ id, confirm }) => {
    try {
      requireWrites(config);
      requireConfirm("immich_delete_tag", confirm);
      await sdk.deleteTag({ id });
      return asMcpResponse({ deleted: id });
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_add_tag_to_assets", "Tag multiple assets with a tag.", {
    id: Uuid,
    assetIds: BulkIds,
  }, async ({ id, assetIds }) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.tagAssets({ id, bulkIdsDto: { ids: assetIds } as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_remove_tag_from_assets", "Untag multiple assets.", {
    id: Uuid,
    assetIds: BulkIds,
  }, async ({ id, assetIds }) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.untagAssets({ id, bulkIdsDto: { ids: assetIds } as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });
}
