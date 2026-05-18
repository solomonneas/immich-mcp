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

// Earliest sentinel for "any trashed item" - Immich treats trashedAfter as inclusive,
// so an epoch-zero timestamp matches every trashed asset regardless of trash date.
const TRASH_ALL_SENTINEL = "1970-01-01T00:00:00.000Z";

interface TrashSearchItem {
  id: string;
  isTrashed?: boolean;
}

interface TrashSearchResponse {
  assets?: {
    items?: TrashSearchItem[];
    nextPage?: string | null;
  };
}

export function registerTrashTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_list_trash",
    "List trashed assets, paginated. Uses withDeleted:true and trashedAfter sentinel to scope to trash. Filter by takenAfter/takenBefore/type.",
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
          sdk.searchAssets({
            metadataSearchDto: {
              ...args,
              withDeleted: true,
              trashedAfter: TRASH_ALL_SENTINEL,
            } as never,
          }),
        );
        // Post-filter to trashed-only as belt-and-suspenders against any future
        // SDK/server change that broadens trashedAfter semantics.
        const r = res as TrashSearchResponse;
        const items = (r.assets?.items ?? []).filter((a) => a.isTrashed === true);
        const out = {
          ...(r as object),
          assets: {
            ...(r.assets ?? {}),
            items,
          },
        };
        return asMcpResponse(out);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_restore_by_query",
    "Restore trashed assets matching a filter. Writes-gated. Calls SDK restoreAssets. With NO filter args, requires confirm:true (would restore every trashed asset).",
    {
      takenAfter: z.string().datetime().optional(),
      takenBefore: z.string().datetime().optional(),
      type: z.enum(["IMAGE", "VIDEO", "AUDIO", "OTHER"]).optional(),
      maxRestore: z.number().int().min(1).max(20000).optional(),
      confirm: z.boolean().optional(),
    },
    async (args) => {
      try {
        requireWrites(config);
        const hasFilter = Boolean(args.takenAfter || args.takenBefore || args.type);
        if (!hasFilter && args.confirm !== true) {
          return asMcpError(
            "immich_restore_by_query with no filter would restore all trashed assets. Pass { confirm: true } to proceed, or add a takenAfter/takenBefore/type filter.",
          );
        }
        const cap = args.maxRestore ?? 5000;
        const { maxRestore: _omitCap, confirm: _omitConfirm, ...filter } = args;
        void _omitCap;
        void _omitConfirm;

        const ids: string[] = [];
        let nextPage: string | null | undefined = undefined;
        // Page through trash results until exhausted or cap exceeded.
        // searchAssets nextPage is a stringified page number per the Immich API.
        let page: number | undefined = undefined;
        const pageSize = 1000;
        for (;;) {
          const search = await withRetry("searchAssets:trash", () =>
            sdk.searchAssets({
              metadataSearchDto: {
                ...filter,
                withDeleted: true,
                trashedAfter: TRASH_ALL_SENTINEL,
                size: pageSize,
                ...(page !== undefined ? { page } : {}),
              } as never,
            }),
          );
          const r = search as TrashSearchResponse;
          const items = (r.assets?.items ?? []).filter((a) => a.isTrashed === true);
          for (const a of items) {
            ids.push(a.id);
            if (ids.length > cap) break;
          }
          if (ids.length > cap) break;
          nextPage = r.assets?.nextPage;
          if (!nextPage) break;
          const parsed = parseInt(nextPage, 10);
          if (!Number.isFinite(parsed)) break;
          page = parsed;
        }

        if (ids.length === 0) return asMcpResponse({ restored: 0 });
        if (ids.length > cap) {
          return asMcpError(
            `match count exceeds maxRestore=${cap} (collected ${ids.length} so far). Tighten the filter or raise maxRestore.`,
          );
        }
        await withRetry("restoreAssets", () =>
          sdk.restoreAssets({ bulkIdsDto: { ids } as never }),
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
