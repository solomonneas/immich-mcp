import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid } from "../types.js";
import { withRetry } from "../retry.js";
import { asMcpResponse, asMcpError, surfaceError, requireWrites } from "./_util.js";

export function registerAlbumFlowTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_search_then_album",
    "Run a smart or metadata search, then create a new album and add the matching assets. Writes-gated.",
    {
      albumName: z.string().min(1),
      description: z.string().optional(),
      smartQuery: z.string().optional(),
      metadataFilter: z.object({
        city: z.string().optional(),
        country: z.string().optional(),
        state: z.string().optional(),
        takenAfter: z.string().datetime().optional(),
        takenBefore: z.string().datetime().optional(),
        personIds: z.array(Uuid).optional(),
        tagIds: z.array(Uuid).optional(),
        type: z.enum(["IMAGE", "VIDEO", "AUDIO", "OTHER"]).optional(),
      }).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ albumName, description, smartQuery, metadataFilter, limit }) => {
      try {
        requireWrites(config);
        if (!smartQuery && !metadataFilter) {
          return asMcpError("Either smartQuery or metadataFilter is required.");
        }
        if (smartQuery && metadataFilter) {
          return asMcpError("Provide exactly one of smartQuery or metadataFilter.");
        }
        const size = limit ?? 200;
        let assetIds: string[] = [];
        if (smartQuery) {
          const r = await withRetry("searchSmart", () =>
            sdk.searchSmart({ smartSearchDto: { query: smartQuery, size } as never }),
          );
          assetIds = ((r as unknown as { assets?: { items?: { id: string }[] } }).assets?.items ?? []).map((a) => a.id);
        } else {
          const r = await withRetry("searchAssets", () =>
            sdk.searchAssets({ metadataSearchDto: { ...metadataFilter, size } as never }),
          );
          assetIds = ((r as unknown as { assets?: { items?: { id: string }[] } }).assets?.items ?? []).map((a) => a.id);
        }
        if (assetIds.length === 0) {
          return asMcpResponse({ created: false, reason: "search returned no matches; album not created", assetIds });
        }
        const album = await withRetry("createAlbum", () =>
          sdk.createAlbum({ createAlbumDto: { albumName, description, assetIds } as never }),
        );
        const albumId = (album as unknown as { id?: string }).id;
        return asMcpResponse({
          created: true,
          albumId,
          albumName,
          assetCount: assetIds.length,
        });
      } catch (e) { return asMcpError(surfaceError(e)); }
    },
  );
}
