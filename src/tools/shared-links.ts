import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid } from "../types.js";
import { asMcpResponse, asMcpError, surfaceError, requireWrites, requireConfirm } from "./_util.js";

export function registerSharedLinkTools(server: McpServer, config: Config): void {
  server.tool("immich_list_shared_links", "List shared links.", {
    albumId: Uuid.optional(),
    id: Uuid.optional(),
  }, async (args) => {
    try { return asMcpResponse(await sdk.getAllSharedLinks(args)); }
    catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_get_shared_link", "Get one shared link.", { id: Uuid }, async ({ id }) => {
    try { return asMcpResponse(await sdk.getSharedLinkById({ id })); }
    catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_create_shared_link", "Create a shareable link to an album or asset set.", {
    type: z.enum(["ALBUM", "INDIVIDUAL"]),
    albumId: Uuid.optional(),
    assetIds: z.array(Uuid).optional(),
    description: z.string().optional(),
    password: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
    allowDownload: z.boolean().optional(),
    allowUpload: z.boolean().optional(),
    showMetadata: z.boolean().optional(),
  }, async (args) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.createSharedLink({ sharedLinkCreateDto: args as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_update_shared_link", "Edit a shared link's settings.", {
    id: Uuid,
    description: z.string().optional(),
    password: z.string().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    allowDownload: z.boolean().optional(),
    allowUpload: z.boolean().optional(),
    showMetadata: z.boolean().optional(),
  }, async ({ id, ...rest }) => {
    try {
      requireWrites(config);
      return asMcpResponse(await sdk.updateSharedLink({ id, sharedLinkEditDto: rest as never }));
    } catch (e) { return asMcpError(surfaceError(e)); }
  });

  server.tool("immich_delete_shared_link", "Delete a shared link. Requires confirm: true.", {
    id: Uuid,
    confirm: z.boolean().optional(),
  }, async ({ id, confirm }) => {
    try {
      requireWrites(config);
      requireConfirm("immich_delete_shared_link", confirm);
      await sdk.removeSharedLink({ id });
      return asMcpResponse({ deleted: id });
    } catch (e) { return asMcpError(surfaceError(e)); }
  });
}
