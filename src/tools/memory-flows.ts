import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { withRetry } from "../retry.js";
import { asMcpResponse, asMcpError, surfaceError } from "./_util.js";

export function registerMemoryFlowTools(server: McpServer, _config: Config): void {
  server.tool(
    "immich_memories_today",
    "Today's memory lanes (X years ago today), formatted for chat-friendly output. yearLabel describes the age in years.",
    {
      date: z.string().datetime().optional(),
      maxAssetsPerLane: z.number().int().min(1).max(20).optional(),
    },
    async (args) => {
      try {
        const targetISO = args.date ?? new Date().toISOString();
        const targetYear = new Date(targetISO).getUTCFullYear();
        const cap = args.maxAssetsPerLane ?? 6;
        const raw = await withRetry("searchMemories", () =>
          sdk.searchMemories({ $for: targetISO, isTrashed: false }),
        );
        const memories = raw as unknown as Array<{
          id: string;
          memoryAt?: string;
          assets?: Array<{ id: string }>;
        }>;
        const lanes = memories.map((m) => {
          const memoryYear = m.memoryAt ? new Date(m.memoryAt).getUTCFullYear() : targetYear;
          const yearsAgo = targetYear - memoryYear;
          return {
            memoryId: m.id,
            memoryAt: m.memoryAt,
            yearLabel: yearsAgo <= 0 ? "today" : `${yearsAgo} year${yearsAgo === 1 ? "" : "s"} ago`,
            assetCount: (m.assets ?? []).length,
            sampleAssetIds: (m.assets ?? []).slice(0, cap).map((a) => a.id),
          };
        });
        return asMcpResponse({ date: targetISO, lanes });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_daily_digest",
    "Composite: server stats + today's memory lanes + assets uploaded to Immich in the last N hours (filtered by createdAfter, not capture date). Markdown text payload suitable for cron-driven Discord/Telegram drops.",
    {
      sinceHours: z.number().int().min(1).max(168).optional(),
    },
    async ({ sinceHours }) => {
      try {
        const hours = sinceHours ?? 24;
        const since = new Date(Date.now() - hours * 3600_000).toISOString();
        const [stats, memories, recent] = await Promise.all([
          withRetry("getAssetStatistics", () => sdk.getAssetStatistics({})),
          withRetry("searchMemories", () =>
            sdk.searchMemories({ $for: new Date().toISOString(), isTrashed: false }),
          ),
          withRetry("searchAssets", () =>
            sdk.searchAssets({ metadataSearchDto: { createdAfter: since, size: 20 } as never }),
          ),
        ]);
        const s = stats as unknown as { images: number; videos: number; total: number };
        const memCount = Array.isArray(memories) ? (memories as unknown as unknown[]).length : 0;
        const recentItems =
          (recent as unknown as { assets?: { items?: { id: string }[] } }).assets?.items ?? [];
        const md = [
          `# Immich daily digest`,
          ``,
          `**Library:** ${s.total} assets (${s.images} photos, ${s.videos} videos)`,
          `**Memory lanes today:** ${memCount}`,
          `**Uploaded in the last ${hours}h:** ${recentItems.length}`,
        ].join("\n");
        return asMcpResponse({
          markdown: md,
          stats: s,
          memoryLaneCount: memCount,
          recentUploadCount: recentItems.length,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
