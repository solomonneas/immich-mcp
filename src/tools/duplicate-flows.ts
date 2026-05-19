import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import {
  asMcpResponse,
  asMcpError,
  surfaceError,
  requireWrites,
  requireConfirm,
} from "./_util.js";

interface DupAsset {
  id: string;
  originalFileName?: string;
  fileCreatedAt?: string;
  exifInfo?: { fileSizeInByte?: number | string };
}

interface DupGroup {
  duplicateId: string;
  assets: DupAsset[];
}

type Category = "byte_exact" | "resolution_variants" | "burst_sequence" | "edits" | "unknown";

function fileSize(a: DupAsset): number {
  return Number(a.exifInfo?.fileSizeInByte ?? 0);
}

function byteDupeSubgroups(group: DupGroup): Map<string, DupAsset[]> {
  const buckets = new Map<string, DupAsset[]>();
  for (const a of group.assets) {
    const key = `${a.originalFileName ?? ""}|${fileSize(a)}`;
    const arr = buckets.get(key) ?? [];
    arr.push(a);
    buckets.set(key, arr);
  }
  for (const k of [...buckets.keys()]) {
    if ((buckets.get(k) ?? []).length < 2) buckets.delete(k);
  }
  return buckets;
}

function categorize(g: DupGroup): Category {
  if (byteDupeSubgroups(g).size > 0) return "byte_exact";
  const names = g.assets.map((a) => a.originalFileName ?? "");
  if (names.some((n) => /1080p|4k|720p|480p|\bhd\b|\bsd\b|\blow\b|\bhigh\b/i.test(n))) {
    return "resolution_variants";
  }
  const tsRe = /^(\d{8}_\d{6})/;
  const prefixes = names.map((n) => n.match(tsRe)?.[1] ?? "");
  if (prefixes.every((p) => p && p === prefixes[0])) return "burst_sequence";
  if (names.some((n) => / - Copy\.|\(\d+\)\.|_edited\.|_retouch\./i.test(n))) return "edits";
  return "unknown";
}

function pickKeeper(bucket: DupAsset[], strategy: "oldest" | "largest"): DupAsset {
  const sorted = [...bucket];
  if (strategy === "oldest") {
    sorted.sort((a, b) => (a.fileCreatedAt ?? "").localeCompare(b.fileCreatedAt ?? ""));
  } else {
    sorted.sort((a, b) => fileSize(b) - fileSize(a));
  }
  return sorted[0]!;
}

// Bucket detail shape used by both find_byte_dupes and resolve_with_keep_strategy.
export type EnrichedAssetRef = {
  id: string;
  filename: string;
  size: number;
  fileCreatedAt: string | undefined;
  albumIds: string[];
  albumNames: string[];
  webUrl?: string;
};
export type EnrichedBucket = {
  duplicateId: string;
  filename: string;
  size: number;
  reclaimableBytes: number;
  matchReason: "byte-exact" | "perceptual-clip" | "resolution-variants" | "burst-sequence" | "edits";
  keeper: EnrichedAssetRef;
  discards: EnrichedAssetRef[];
  flagged?: { reason: string };
};

// Album lookup: returns Map<assetId, Array<{ id, name }>>.
export async function buildAssetAlbumIndex(): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  try {
    const albums = (await sdk.getAllAlbums({})) as unknown as Array<{ id: string; albumName: string }>;
    for (const album of albums) {
      try {
        const detail = (await sdk.getAlbumInfo({ id: album.id })) as unknown as {
          albumName?: string;
          assets?: Array<{ id: string }>;
        };
        const name = detail.albumName ?? album.albumName;
        for (const a of detail.assets ?? []) {
          const arr = map.get(a.id) ?? [];
          arr.push({ id: album.id, name });
          map.set(a.id, arr);
        }
      } catch { /* skip unreadable album */ }
    }
  } catch { /* return empty if albums endpoint fails */ }
  return map;
}

export function enrichAsset(
  a: DupAsset,
  index: Map<string, { id: string; name: string }[]>,
  webBaseUrl?: string,
): EnrichedAssetRef {
  const albums = index.get(a.id) ?? [];
  return {
    id: a.id,
    filename: a.originalFileName ?? "",
    size: fileSize(a),
    fileCreatedAt: a.fileCreatedAt,
    albumIds: albums.map((x) => x.id),
    albumNames: albums.map((x) => x.name),
    webUrl: webBaseUrl ? `${webBaseUrl.replace(/\/+$/, "")}/photos/${a.id}` : undefined,
  };
}

// Keeper selection with optional album awareness.
export function pickKeeperWithAlbums(
  bucket: DupAsset[],
  strategy: "oldest" | "largest",
  albumIndex: Map<string, { id: string; name: string }[]>,
  albumAware: boolean,
): { keeper: DupAsset | null; flagged?: { reason: string } } {
  if (albumAware) {
    const inAlbum = bucket.filter((a) => (albumIndex.get(a.id) ?? []).length > 0);
    if (inAlbum.length === 1) return { keeper: inAlbum[0]! };
    if (inAlbum.length > 1) {
      return {
        keeper: null,
        flagged: { reason: `${inAlbum.length} assets in albums (split curation), skipped for safety` },
      };
    }
    // Fall through to strategy when none are in albums.
  }
  return { keeper: pickKeeper(bucket, strategy) };
}

// Restore note string emitted by resolve responses.
export const RESTORE_NOTE =
  "Trashed assets are recoverable for 30 days. Use immich_restore_by_query (or your Immich web UI > Library > Trash) to restore. Permanent removal: auto at 30d OR via immich_empty_trash (writes + confirm).";

// CSV helpers (RFC 4180 ish).
function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function writePlanCsv(path: string, rows: EnrichedBucket[]): Promise<void> {
  const header = [
    "duplicateId", "filename", "size", "reclaimableBytes", "matchReason",
    "keeperId", "keeperFileCreatedAt", "keeperAlbums",
    "discardIds", "discardAlbums",
    "flagged", "flaggedReason",
  ].join(",");
  const body = rows.map((b) => [
    b.duplicateId, b.filename, b.size, b.reclaimableBytes, b.matchReason,
    b.keeper.id, b.keeper.fileCreatedAt ?? "", b.keeper.albumNames.join(";"),
    b.discards.map((d) => d.id).join(";"),
    b.discards.flatMap((d) => d.albumNames).join(";"),
    b.flagged ? "true" : "false",
    b.flagged?.reason ?? "",
  ].map(csvEscape).join(",")).join("\n");
  const content = body.length > 0 ? header + "\n" + body + "\n" : header + "\n";
  await fs.writeFile(path, content, "utf8");
}

// Deterministic shuffle for tailSample: stable order based on a slice of the duplicateId.
function deterministicTailSample(buckets: EnrichedBucket[], count: number): EnrichedBucket[] {
  const sorted = [...buckets].sort((a, b) =>
    a.duplicateId.slice(0, 8).localeCompare(b.duplicateId.slice(0, 8)),
  );
  return sorted.slice(0, count);
}

function buildEnrichedBucket(
  duplicateId: string,
  filename: string,
  keeper: DupAsset,
  discards: DupAsset[],
  reclaimableBytes: number,
  albumIndex: Map<string, { id: string; name: string }[]>,
  webBaseUrl?: string,
  flagged?: { reason: string },
): EnrichedBucket {
  return {
    duplicateId,
    filename,
    size: fileSize(keeper),
    reclaimableBytes,
    matchReason: "byte-exact",
    keeper: enrichAsset(keeper, albumIndex, webBaseUrl),
    discards: discards.map((d) => enrichAsset(d, albumIndex, webBaseUrl)),
    ...(flagged ? { flagged } : {}),
  };
}

// Flagged buckets have a keeper-less shape; we still emit something useful for display.
// Use the first bucket member as the placeholder keeper so the row schema stays consistent.
function buildFlaggedBucket(
  duplicateId: string,
  filename: string,
  bucket: DupAsset[],
  albumIndex: Map<string, { id: string; name: string }[]>,
  webBaseUrl: string | undefined,
  reason: string,
): EnrichedBucket {
  const reclaimableBytes = bucket.slice(1).reduce((s, a) => s + fileSize(a), 0);
  return {
    duplicateId,
    filename,
    size: fileSize(bucket[0]!),
    reclaimableBytes,
    matchReason: "byte-exact",
    keeper: enrichAsset(bucket[0]!, albumIndex, webBaseUrl),
    discards: bucket.slice(1).map((d) => enrichAsset(d, albumIndex, webBaseUrl)),
    flagged: { reason },
  };
}

export function registerDuplicateFlowTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_categorize_duplicates",
    "Bin duplicate groups by shape: byte_exact, resolution_variants, burst_sequence, edits, unknown. Returns counts plus up to 3 sample groups per category.",
    {},
    async () => {
      try {
        const raw = await sdk.getAssetDuplicates();
        const groups = raw as unknown as DupGroup[];
        const cats: Record<Category, DupGroup[]> = {
          byte_exact: [],
          resolution_variants: [],
          burst_sequence: [],
          edits: [],
          unknown: [],
        };
        for (const g of groups) cats[categorize(g)].push(g);
        const byCategory = Object.fromEntries(
          (Object.entries(cats) as [Category, DupGroup[]][]).map(([k, v]) => [k, v.length]),
        );
        const samples = Object.fromEntries(
          (Object.entries(cats) as [Category, DupGroup[]][]).map(([k, v]) => [k, v.slice(0, 3)]),
        );
        return asMcpResponse({ total: groups.length, byCategory, samples });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_find_byte_dupes",
    "Return ready-to-trash candidates: per (filename, size) bucket inside each duplicate group, keep the oldest, list the rest as discardIds. Album-aware: buckets with multiple in-album assets are flagged for manual review.",
    {
      minSizeBytes: z.number().int().min(0).optional(),
      albumAware: z.boolean().optional(),
      detailLimit: z.number().int().min(1).max(500).optional(),
      webBaseUrl: z.string().url().optional(),
    },
    async ({ minSizeBytes, albumAware, detailLimit, webBaseUrl }) => {
      try {
        const raw = await sdk.getAssetDuplicates();
        const groups = raw as unknown as DupGroup[];
        const min = minSizeBytes ?? 0;
        const aware = albumAware ?? true;
        const limit = detailLimit ?? 50;
        const albumIndex = aware
          ? await buildAssetAlbumIndex()
          : new Map<string, { id: string; name: string }[]>();

        const candidates: Array<{
          duplicateId: string;
          filename: string;
          size: number;
          keeperId: string;
          discardIds: string[];
          reclaimableBytes: number;
          matchReason: "byte-exact";
        }> = [];
        const enrichedKept: EnrichedBucket[] = [];
        const flagged: EnrichedBucket[] = [];
        let totalDiscardAssets = 0;
        let totalReclaimable = 0;
        for (const g of groups) {
          const buckets = byteDupeSubgroups(g);
          for (const [key, bucket] of buckets.entries()) {
            const [filename] = key.split("|");
            const fname = filename ?? "";
            const sample = bucket[0]!;
            const size = fileSize(sample);
            if (size < min) continue;
            const decision = pickKeeperWithAlbums(bucket, "oldest", albumIndex, aware);
            if (decision.flagged) {
              flagged.push(
                buildFlaggedBucket(g.duplicateId, fname, bucket, albumIndex, webBaseUrl, decision.flagged.reason),
              );
              continue;
            }
            const keeper = decision.keeper!;
            const discards = bucket.filter((a) => a.id !== keeper.id);
            const reclaim = discards.reduce((s, a) => s + fileSize(a), 0);
            candidates.push({
              duplicateId: g.duplicateId,
              filename: fname,
              size,
              keeperId: keeper.id,
              discardIds: discards.map((a) => a.id),
              reclaimableBytes: reclaim,
              matchReason: "byte-exact",
            });
            enrichedKept.push(
              buildEnrichedBucket(g.duplicateId, fname, keeper, discards, reclaim, albumIndex, webBaseUrl),
            );
            totalDiscardAssets += discards.length;
            totalReclaimable += reclaim;
          }
        }
        const sortedKept = [...enrichedKept].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
        const topByReclaim = sortedKept.slice(0, limit);
        const rest = sortedKept.slice(limit);
        const tailSample = deterministicTailSample(rest, 10);
        return asMcpResponse({
          candidates,
          totalCandidates: candidates.length,
          totalDiscardAssets,
          totalReclaimableBytes: totalReclaimable,
          flagged,
          topByReclaim,
          tailSample,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_resolve_with_keep_strategy",
    "End-to-end dedupe. Dry-run by default. delete: true + writes enabled = soft trash (recoverable). permanent: true + confirm: true = bypass trash. Album-aware skips buckets with split curation.",
    {
      strategy: z.enum(["byte_dupes_keep_oldest", "byte_dupes_keep_largest"]),
      minSizeBytes: z.number().int().min(0).optional(),
      delete: z.boolean().optional(),
      permanent: z.boolean().optional(),
      confirm: z.boolean().optional(),
      maxDiscards: z.number().int().min(1).max(20000).optional(),
      albumAware: z.boolean().optional(),
      detailLimit: z.number().int().min(1).max(500).optional(),
      webBaseUrl: z.string().url().optional(),
      exportTo: z.string().optional(),
    },
    async (args) => {
      try {
        const cap = args.maxDiscards ?? 5000;
        const raw = await sdk.getAssetDuplicates();
        const groups = raw as unknown as DupGroup[];
        const keepBy = args.strategy === "byte_dupes_keep_largest" ? "largest" : "oldest";
        const aware = args.albumAware ?? true;
        const limit = args.detailLimit ?? 50;
        const webBaseUrl = args.webBaseUrl;
        const albumIndex = aware
          ? await buildAssetAlbumIndex()
          : new Map<string, { id: string; name: string }[]>();

        const discardIds: string[] = [];
        let reclaim = 0;
        let buckets = 0;
        const enrichedKept: EnrichedBucket[] = [];
        const flagged: EnrichedBucket[] = [];
        const min = args.minSizeBytes ?? 0;
        for (const g of groups) {
          for (const [key, bucket] of byteDupeSubgroups(g).entries()) {
            const [filename] = key.split("|");
            const fname = filename ?? "";
            const sample = bucket[0]!;
            if (fileSize(sample) < min) continue;
            const decision = pickKeeperWithAlbums(bucket, keepBy, albumIndex, aware);
            if (decision.flagged) {
              flagged.push(
                buildFlaggedBucket(g.duplicateId, fname, bucket, albumIndex, webBaseUrl, decision.flagged.reason),
              );
              continue;
            }
            const keeper = decision.keeper!;
            buckets++;
            const discards = bucket.filter((a) => a.id !== keeper.id);
            const reclaimBucket = discards.reduce((s, a) => s + fileSize(a), 0);
            for (const a of discards) {
              discardIds.push(a.id);
            }
            reclaim += reclaimBucket;
            enrichedKept.push(
              buildEnrichedBucket(g.duplicateId, fname, keeper, discards, reclaimBucket, albumIndex, webBaseUrl),
            );
          }
        }
        const sortedKept = [...enrichedKept].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
        const topByReclaim = sortedKept.slice(0, limit);
        const rest = sortedKept.slice(limit);
        const tailSample = deterministicTailSample(rest, 10);
        const flaggedDetail = flagged.slice(0, limit);
        const plan = {
          strategy: args.strategy,
          bucketsResolved: buckets,
          discardCount: discardIds.length,
          reclaimableBytes: reclaim,
          flaggedCount: flagged.length,
        };

        let exportPath: string | undefined;
        let exportRowCount: number | undefined;
        if (args.exportTo) {
          const rows = [...enrichedKept, ...flagged];
          await writePlanCsv(args.exportTo, rows);
          exportPath = args.exportTo;
          exportRowCount = rows.length;
        }

        if (args.delete !== true) {
          return asMcpResponse({
            dryRun: true,
            plan,
            flagged: flaggedDetail,
            topByReclaim,
            tailSample,
            ...(exportPath ? { exportPath, exportRowCount } : {}),
            restoreNote: RESTORE_NOTE,
          });
        }
        requireWrites(config);
        if (args.permanent === true) requireConfirm("immich_resolve_with_keep_strategy", args.confirm);
        if (discardIds.length > cap) {
          return asMcpError(
            `discard list is ${discardIds.length}, exceeds maxDiscards=${cap}. Raise maxDiscards or lower scope.`,
          );
        }
        const BATCH = 500;
        let deleted = 0;
        for (let i = 0; i < discardIds.length; i += BATCH) {
          const slice = discardIds.slice(i, i + BATCH);
          await sdk.deleteAssets({ assetBulkDeleteDto: { ids: slice, force: args.permanent ?? false } as never });
          deleted += slice.length;
        }
        return asMcpResponse({
          dryRun: false,
          executed: true,
          strategy: args.strategy,
          deletedCount: deleted,
          reclaimedBytes: reclaim,
          permanent: args.permanent ?? false,
          flaggedCount: flagged.length,
          ...(exportPath ? { exportPath, exportRowCount } : {}),
          restoreNote: RESTORE_NOTE,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
