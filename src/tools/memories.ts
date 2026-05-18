import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid } from "../types.js";
import { asMcpResponse, asMcpError, surfaceError } from "./_util.js";

export function registerMemoryTools(server: McpServer, _config: Config): void {
  server.tool("immich_list_memories",
    "List memory lanes (years-ago, etc.). Filter by date, type, saved, trashed.",
    {
      for: z.string().datetime().optional(),
      isSaved: z.boolean().optional(),
      isTrashed: z.boolean().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      size: z.number().int().min(1).max(1000).optional(),
      type: z.string().optional(),
    }, async (args) => {
      try {
        const res = await sdk.searchMemories({
          $for: args.for,
          isSaved: args.isSaved,
          isTrashed: args.isTrashed,
          order: args.order as never,
          size: args.size,
          $type: args.type as never,
        });
        return asMcpResponse(res);
      } catch (e) { return asMcpError(surfaceError(e)); }
    });

  server.tool("immich_get_memory", "Get a memory by id (with its assets).", { id: Uuid }, async ({ id }) => {
    try { return asMcpResponse(await sdk.getMemory({ id })); }
    catch (e) { return asMcpError(surfaceError(e)); }
  });
}
