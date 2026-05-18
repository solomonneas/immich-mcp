import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { withRetry } from "../retry.js";
import {
  asMcpResponse,
  asMcpError,
  surfaceError,
  requireWrites,
  requireConfirm,
} from "./_util.js";

export function registerTrashTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_list_trash",
    "List trashed assets, paginated. Filter by takenAfter/takenBefore/type.",
    {
      takenAfter: z.string().datetime().optional(),
      takenBefore: z.string().datetime().optional(),
      type: z.enum(["IMAGE", "VIDEO", "AUDIO", "OTHER"]).optional(),
      size: z.number().int().min(1).max(1000).optional(),
      page: z.number().int().min(1).optional(),
    },
    async (args) => {
      try {
        const res = await withRetry("searchAssets:trash", () =>
          sdk.searchAssets({ metadataSearchDto: { ...args, isTrashed: true } as never }),
        );
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_restore_by_query",
    "Restore trashed assets matching a filter. Writes-gated. Recoverable (just flips isTrashed).",
    {
      takenAfter: z.string().datetime().optional(),
      takenBefore: z.string().datetime().optional(),
      type: z.enum(["IMAGE", "VIDEO", "AUDIO", "OTHER"]).optional(),
      maxRestore: z.number().int().min(1).max(20000).optional(),
    },
    async (args) => {
      try {
        requireWrites(config);
        const cap = args.maxRestore ?? 5000;
        const { maxRestore: _omit, ...filter } = args;
        void _omit;
        const search = await withRetry("searchAssets:trash", () =>
          sdk.searchAssets({
            metadataSearchDto: { ...filter, isTrashed: true, size: 1000 } as never,
          }),
        );
        const ids = ((search as unknown as { assets?: { items?: { id: string }[] } }).assets?.items ?? []).map((a) => a.id);
        if (ids.length === 0) return asMcpResponse({ restored: 0 });
        if (ids.length > cap) {
          return asMcpError(
            `match count ${ids.length} exceeds maxRestore=${cap}. Tighten the filter or raise maxRestore.`,
          );
        }
        await withRetry("updateAssets:restore", () =>
          sdk.updateAssets({ assetBulkUpdateDto: { ids, isTrashed: false } as never }),
        );
        return asMcpResponse({ restored: ids.length });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_empty_trash",
    "Permanently delete EVERYTHING in trash. Writes + confirm: true required. NOT REVERSIBLE.",
    { confirm: z.boolean().optional() },
    async ({ confirm }) => {
      try {
        requireWrites(config);
        requireConfirm("immich_empty_trash", confirm);
        const sdkAny = sdk as unknown as { emptyTrash?: () => Promise<unknown> };
        if (typeof sdkAny.emptyTrash !== "function") {
          return asMcpError(
            "Immich SDK does not export emptyTrash on this version. Use immich_list_trash + immich_delete_asset with permanent: true.",
          );
        }
        await withRetry("emptyTrash", () => sdkAny.emptyTrash!());
        return asMcpResponse({ emptied: true });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
