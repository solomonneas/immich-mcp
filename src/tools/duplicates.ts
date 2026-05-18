import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid } from "../types.js";
import { asMcpResponse, asMcpError, surfaceError, requireWrites, requireConfirm } from "./_util.js";

export function registerDuplicateTools(server: McpServer, config: Config): void {
  server.tool("immich_list_duplicates",
    "List groups of detected duplicate assets. Use with immich_resolve_duplicates.",
    {}, async () => {
      try { return asMcpResponse(await sdk.getAssetDuplicates()); }
      catch (e) { return asMcpError(surfaceError(e)); }
    });

  server.tool("immich_resolve_duplicates",
    "Resolve a duplicate group. Provide keep[] + discard[]. Default is dry-run (no SDK call). Pass delete: true + confirm: true to permanently remove discard[].",
    {
      keep: z.array(Uuid).min(1).max(100),
      discard: z.array(Uuid).min(1).max(100),
      delete: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
    async ({ keep, discard, delete: del, confirm }) => {
      try {
        if (del !== true) {
          return asMcpResponse({ dryRun: true, keep, discard, deleted: 0 });
        }
        requireWrites(config);
        requireConfirm("immich_resolve_duplicates", confirm);
        await sdk.deleteAssets({ assetBulkDeleteDto: { ids: discard, force: true } as never });
        return asMcpResponse({ dryRun: false, keep, discard, deleted: discard.length });
      } catch (e) { return asMcpError(surfaceError(e)); }
    });
}
