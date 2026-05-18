import { z } from "zod";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid, BulkIds } from "../types.js";
import {
  asMcpResponse,
  asMcpError,
  surfaceError,
  requireWrites,
  requireConfirm,
} from "./_util.js";

export function registerAssetTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_list_assets",
    "List/search assets (paginated). Filters: isFavorite, isArchived, takenAfter, takenBefore, type, personIds, albumIds, tagIds.",
    {
      isFavorite: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      takenAfter: z.string().datetime().optional(),
      takenBefore: z.string().datetime().optional(),
      type: z.enum(["IMAGE", "VIDEO", "AUDIO", "OTHER"]).optional(),
      personIds: z.array(Uuid).optional(),
      albumIds: z.array(Uuid).optional(),
      tagIds: z.array(Uuid).optional(),
      size: z.number().int().min(1).max(1000).optional(),
      page: z.number().int().min(1).optional(),
    },
    async (args) => {
      try {
        const res = await sdk.searchAssets({ metadataSearchDto: args as never });
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_get_asset",
    "Get full metadata for one asset.",
    { id: Uuid },
    async ({ id }) => {
      try {
        const res = await sdk.getAssetInfo({ id });
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_get_asset_exif",
    "Get EXIF / IPTC metadata for an asset.",
    { id: Uuid },
    async ({ id }) => {
      try {
        const res = await sdk.getAssetInfo({ id });
        const exif = (res as unknown as { exifInfo?: unknown }).exifInfo ?? null;
        return asMcpResponse({ id, exifInfo: exif });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_download_asset_original",
    "Return the Immich URL path for the original asset file.",
    { id: Uuid },
    async ({ id }) => {
      try {
        const fn = (sdk as unknown as { getAssetOriginalPath: (id: string) => string | Promise<string> }).getAssetOriginalPath;
        const url = await fn(id);
        return asMcpResponse({ id, url });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_download_asset_thumbnail",
    "Return the Immich URL path for the asset thumbnail.",
    { id: Uuid },
    async ({ id }) => {
      try {
        const fn = (sdk as unknown as { getAssetThumbnailPath: (id: string) => string | Promise<string> }).getAssetThumbnailPath;
        const url = await fn(id);
        return asMcpResponse({ id, url });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_get_asset_statistics",
    "Per-user asset statistics (images + videos counts).",
    {},
    async () => {
      try {
        const res = await sdk.getAssetStatistics({});
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  // --- writes below ---

  server.tool(
    "immich_upload_asset_from_path",
    "Upload a local file to Immich.",
    {
      filePath: z.string().min(1),
      deviceId: z.string().default("immich-mcp"),
    },
    async ({ filePath, deviceId }) => {
      try {
        requireWrites(config);
        const buf = await fs.readFile(filePath);
        const stat = await fs.stat(filePath);
        const checksum = createHash("sha1").update(buf).digest("base64");
        const deviceAssetId = `${path.basename(filePath)}-${stat.mtimeMs}`;
        const FileCtor =
          (globalThis as unknown as { File?: typeof File }).File ??
          ((await import("node:buffer")) as unknown as { File: typeof File }).File;
        const file = new FileCtor([buf], path.basename(filePath));
        const res = await sdk.uploadAsset({
          xImmichChecksum: checksum,
          assetMediaCreateDto: {
            assetData: file,
            deviceAssetId,
            deviceId,
            fileCreatedAt: new Date(stat.mtime).toISOString(),
            fileModifiedAt: new Date(stat.mtime).toISOString(),
          } as never,
        });
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_update_asset",
    "Update one asset's metadata (description, isFavorite, isArchived, rating, dateTimeOriginal, latitude, longitude).",
    {
      id: Uuid,
      description: z.string().optional(),
      isFavorite: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      rating: z.number().int().min(0).max(5).optional(),
      dateTimeOriginal: z.string().datetime().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    },
    async ({ id, ...rest }) => {
      try {
        requireWrites(config);
        const res = await sdk.updateAsset({ id, updateAssetDto: rest as never });
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_bulk_update_assets",
    "Bulk-update multiple assets. Destructive; requires confirm: true.",
    {
      ids: BulkIds,
      isFavorite: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      rating: z.number().int().min(0).max(5).optional(),
      removeParent: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
    async ({ ids, confirm, ...rest }) => {
      try {
        requireWrites(config);
        requireConfirm("immich_bulk_update_assets", confirm);
        await sdk.updateAssets({ assetBulkUpdateDto: { ids, ...rest } as never });
        return asMcpResponse({ updated: ids.length });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_delete_asset",
    "Delete one or more assets. Default is soft delete (trash, recoverable via immich_restore_from_trash). permanent: true bypasses trash and requires confirm: true.",
    {
      ids: BulkIds,
      permanent: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
    async ({ ids, permanent, confirm }) => {
      try {
        requireWrites(config);
        if (permanent === true) {
          requireConfirm("immich_delete_asset", confirm);
        }
        await sdk.deleteAssets({ assetBulkDeleteDto: { ids, force: permanent ?? false } as never });
        return asMcpResponse({ deleted: ids.length, permanent: permanent ?? false });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_restore_from_trash",
    "Restore previously trashed assets.",
    { ids: BulkIds },
    async ({ ids }) => {
      try {
        requireWrites(config);
        await sdk.updateAssets({ assetBulkUpdateDto: { ids, isTrashed: false } as never });
        return asMcpResponse({ restored: ids.length });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
