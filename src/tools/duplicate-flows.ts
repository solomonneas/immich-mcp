import { promises as fs } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { Uuid } from "../types.js";
import { withRetry } from "../retry.js";
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
  // @immich/sdk AssetResponseDto carries `checksum: string` (base64-encoded
  // SHA1). Treat as optional here so synthetic fixtures and older asset shapes
  // remain compatible; v0.4.2 dispatcher skips assets missing checksum.
  checksum?: string;
}

interface DupGroup {
  duplicateId: string;
  assets: DupAsset[];
}

// MatchMode controls how we decide two assets are "duplicates" inside a single
// Immich duplicate group:
//   - "checksum"  -> SHA1-identical (true byte-identity). Default in v0.4.2.
//   - "name-size" -> same originalFileName + fileSizeInByte (v0.3-v0.4.1
//                    behavior). Removed in v0.5.0 (returns deprecation error).
// Retained as a string-literal type so we can accept and re-route the input
// through resolveSafetyMode() below.
type MatchMode = "checksum" | "name-size";

// SafetyMode (v0.5.0) replaces matchMode with three levels of strictness for
// deciding which assets inside an Immich CLIP duplicate group are safe to act
// on:
//   - "strict-checksum"     -> CLIP group + matching SHA1. Zero false positives.
//   - "clip-name-size-time" -> CLIP group + same filename + size + fileCreatedAt.
//                              Catches re-encodes and re-imports.
//   - "clip-only"           -> CLIP group only. Most permissive; requires review.
export type SafetyMode = "strict-checksum" | "clip-name-size-time" | "clip-only";

type Category =
  | "checksum-exact"
  | "name-size-match"
  | "resolution-variants"
  | "burst-sequence"
  | "edits"
  | "unknown";

function fileSize(a: DupAsset): number {
  return Number(a.exifInfo?.fileSizeInByte ?? 0);
}

function getChecksum(a: DupAsset): string | undefined {
  return (a as unknown as { checksum?: string }).checksum;
}

// Group by SHA1 checksum. Subgroups with <2 members are dropped. Assets that
// have no checksum field are skipped entirely (we cannot prove identity).
function checksumSubgroups(group: DupGroup): Map<string, DupAsset[]> {
  const buckets = new Map<string, DupAsset[]>();
  for (const a of group.assets) {
    const ck = getChecksum(a);
    if (!ck) continue;
    const arr = buckets.get(ck) ?? [];
    arr.push(a);
    buckets.set(ck, arr);
  }
  for (const k of [...buckets.keys()]) {
    if ((buckets.get(k) ?? []).length < 2) buckets.delete(k);
  }
  return buckets;
}

// Group by (originalFileName, fileSizeInByte). This is the v0.3-v0.4.1 path,
// renamed for honesty in v0.4.2 (it was misleadingly called "byte-exact"
// despite never reading any actual bytes).
function nameSizeSubgroups(group: DupGroup): Map<string, DupAsset[]> {
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

function selectSubgroups(group: DupGroup, mode: MatchMode): Map<string, DupAsset[]> {
  return mode === "checksum" ? checksumSubgroups(group) : nameSizeSubgroups(group);
}

// v0.5.0: clip-name-size-time bucketing. CLIP grouped them, AND filename, size,
// and fileCreatedAt all match. This is the "re-encode / re-import" detector:
// assets that look like distinct files on disk (different SHA1) but trace back
// to the same source moment. Drops any asset missing all three signals so we
// never accidentally collapse on the empty-string key.
function clipNameSizeTimeSubgroups(group: DupGroup): Map<string, DupAsset[]> {
  const buckets = new Map<string, DupAsset[]>();
  for (const a of group.assets) {
    const name = a.originalFileName ?? "";
    const size = fileSize(a);
    const taken = a.fileCreatedAt ?? "";
    if (!name || !size || !taken) continue;
    const key = `${name}|${size}|${taken}`;
    const arr = buckets.get(key) ?? [];
    arr.push(a);
    buckets.set(key, arr);
  }
  for (const k of [...buckets.keys()]) {
    if ((buckets.get(k) ?? []).length < 2) buckets.delete(k);
  }
  return buckets;
}

// v0.5.0: clip-only bucketing. The entire CLIP duplicate group is treated as
// one bucket. Most permissive mode; only sensible when the caller has already
// verified the candidates by another channel (e.g. immich_compare_assets).
function clipOnlySubgroups(group: DupGroup): Map<string, DupAsset[]> {
  if (group.assets.length < 2) return new Map();
  return new Map([[group.duplicateId, [...group.assets]]]);
}

export function selectSubgroupsBySafetyMode(
  group: DupGroup,
  mode: SafetyMode,
): Map<string, DupAsset[]> {
  if (mode === "strict-checksum") return checksumSubgroups(group);
  if (mode === "clip-name-size-time") return clipNameSizeTimeSubgroups(group);
  return clipOnlySubgroups(group);
}

// v0.5.0: input router. Accepts either the new `safetyMode` enum or the
// deprecated `matchMode` alias and returns the canonical SafetyMode, or an
// error string when the caller passed `matchMode: "name-size"` (which was the
// v0.3-v0.4.1 unsafe heuristic and is no longer supported in v0.5.0).
export function resolveSafetyMode(input: {
  safetyMode?: SafetyMode;
  matchMode?: MatchMode;
}): SafetyMode | { error: string } {
  if (input.safetyMode) return input.safetyMode;
  if (input.matchMode === "checksum") return "strict-checksum";
  if (input.matchMode === "name-size") {
    return {
      error:
        "matchMode 'name-size' is no longer supported (it produced unsafe matches). " +
        "Use safetyMode 'clip-name-size-time' for re-encode/re-import detection, " +
        "or 'clip-only' for visual-similarity-only matching.",
    };
  }
  return "strict-checksum";
}

function matchReasonForSafetyMode(mode: SafetyMode): BucketMatchReason {
  if (mode === "strict-checksum") return "checksum-exact";
  if (mode === "clip-name-size-time") return "clip-name-size-time";
  return "clip-only";
}

function categorize(g: DupGroup): Category {
  if (checksumSubgroups(g).size > 0) return "checksum-exact";
  if (nameSizeSubgroups(g).size > 0) return "name-size-match";
  const names = g.assets.map((a) => a.originalFileName ?? "");
  if (names.some((n) => /1080p|4k|720p|480p|\bhd\b|\bsd\b|\blow\b|\bhigh\b/i.test(n))) {
    return "resolution-variants";
  }
  const tsRe = /^(\d{8}_\d{6})/;
  const prefixes = names.map((n) => n.match(tsRe)?.[1] ?? "");
  if (prefixes.every((p) => p && p === prefixes[0])) return "burst-sequence";
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
// v0.4.2: matchReason `byte-exact` is split into `checksum-exact` (real SHA1
// match) and `name-size-match` (the weaker v0.3-v0.4.1 heuristic).
// v0.5.0: added `clip-name-size-time` and `clip-only` to label safety-mode buckets.
export type BucketMatchReason =
  | "checksum-exact"
  | "name-size-match"
  | "clip-name-size-time"
  | "clip-only"
  | "perceptual-clip"
  | "resolution-variants"
  | "burst-sequence"
  | "edits";

// v0.5.0: divergence summary surfaces which signals disagree across the bucket.
// Only populated by `immich_find_clip_dupes` (and could be by future tools);
// strict-checksum buckets leave this undefined because divergence is moot when
// every member shares the same SHA1.
export type BucketDivergence = {
  checksumsDiffer: boolean;
  filenamesDiffer: boolean;
  sizesDiffer: boolean;
  takenAtDiffer: boolean;
};

export type EnrichedBucket = {
  duplicateId: string;
  filename: string;
  size: number;
  reclaimableBytes: number;
  matchReason: BucketMatchReason;
  keeper: EnrichedAssetRef | null;
  discards: EnrichedAssetRef[];
  members?: EnrichedAssetRef[];
  flagged?: { reason: string };
  divergence?: BucketDivergence;
};

// Album lookup: returns Map<assetId, Array<{ id, name }>>.
// Errors propagate to the caller (fail-fast). With albumAware=true (the default),
// any failure here surfaces as an MCP error to the user instead of silently
// downgrading to a strategy-only keeper decision, which could delete curated assets.
export async function buildAssetAlbumIndex(): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  const albums = (await sdk.getAllAlbums({})) as unknown as Array<{ id: string; albumName: string }>;
  for (const album of albums) {
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
  }
  return map;
}

function buildWebUrl(webBaseUrl: string | undefined, assetId: string): string | undefined {
  if (!webBaseUrl) return undefined;
  // Trailing-slash normalize then resolve relative path so encodeURIComponent
  // handles odd asset ids safely.
  const base = webBaseUrl.replace(/\/?$/, "/");
  return new URL(`photos/${encodeURIComponent(assetId)}`, base).toString();
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
    webUrl: buildWebUrl(webBaseUrl, a.id),
  };
}

// Reusable zod refinement for webBaseUrl: requires http/https, blocks
// javascript:, ftp:, etc. that z.string().url() otherwise accepts.
const webBaseUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "must be an http:// or https:// URL" });

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
// Neutralizes formula injection (CWE-1236): any cell starting with =, +, -, @,
// tab, or carriage return is prefixed with a single quote so Excel/Sheets treat
// it as literal text instead of evaluating it as a formula on open.
function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
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
  const body = rows.map((b) => {
    // Flagged buckets have keeper:null and empty discards. Emit empty cells
    // for keeper/discard columns so downstream tools cannot confuse the
    // sentinel for an actual selection.
    const keeperId = b.keeper?.id ?? "";
    const keeperCreatedAt = b.keeper?.fileCreatedAt ?? "";
    const keeperAlbums = b.keeper?.albumNames.join(";") ?? "";
    return [
      b.duplicateId, b.filename, b.size, b.reclaimableBytes, b.matchReason,
      keeperId, keeperCreatedAt, keeperAlbums,
      b.discards.map((d) => d.id).join(";"),
      b.discards.flatMap((d) => d.albumNames).join(";"),
      b.flagged ? "true" : "false",
      b.flagged?.reason ?? "",
    ].map(csvEscape).join(",");
  }).join("\n");
  const content = body.length > 0 ? header + "\n" + body + "\n" : header + "\n";

  // Path safety: confirm parent directory exists; surface a clear error if not.
  // Then write with wx so we never silently clobber an existing file.
  const absPath = resolvePath(path);
  const parent = dirname(absPath);
  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) {
      throw new Error(`exportTo parent path is not a directory: ${parent}`);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`exportTo parent directory does not exist: ${parent}`);
    }
    throw e;
  }
  try {
    await fs.writeFile(absPath, content, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`exportTo target already exists (refusing to overwrite): ${absPath}`);
    }
    throw e;
  }
}

// Tail sample: returns the `count` buckets with the lowest reclaimable bytes,
// stable-tiebroken on duplicateId. This actually surfaces "the bottom of the
// pile" so a caller can see what the long tail looks like, instead of the
// first N buckets by id (which was effectively arbitrary).
function deterministicTailSample(buckets: EnrichedBucket[], count: number): EnrichedBucket[] {
  return [...buckets]
    .sort(
      (a, b) =>
        a.reclaimableBytes - b.reclaimableBytes ||
        a.duplicateId.localeCompare(b.duplicateId),
    )
    .slice(0, count);
}

function buildEnrichedBucket(
  duplicateId: string,
  filename: string,
  keeper: DupAsset,
  discards: DupAsset[],
  reclaimableBytes: number,
  albumIndex: Map<string, { id: string; name: string }[]>,
  matchReason: BucketMatchReason,
  webBaseUrl?: string,
  flagged?: { reason: string },
): EnrichedBucket {
  return {
    duplicateId,
    filename,
    size: fileSize(keeper),
    reclaimableBytes,
    matchReason,
    keeper: enrichAsset(keeper, albumIndex, webBaseUrl),
    discards: discards.map((d) => enrichAsset(d, albumIndex, webBaseUrl)),
    ...(flagged ? { flagged } : {}),
  };
}

// Flagged buckets carry no keeper/discards (nothing was selected). We put all
// assets in `members` so downstream tools can display them without being able
// to misuse a placeholder discard list for destructive action.
function buildFlaggedBucket(
  duplicateId: string,
  filename: string,
  bucket: DupAsset[],
  albumIndex: Map<string, { id: string; name: string }[]>,
  matchReason: BucketMatchReason,
  webBaseUrl: string | undefined,
  reason: string,
): EnrichedBucket {
  return {
    duplicateId,
    filename,
    size: fileSize(bucket[0]!),
    reclaimableBytes: 0,
    matchReason,
    keeper: null,
    discards: [],
    members: bucket.map((a) => enrichAsset(a, albumIndex, webBaseUrl)),
    flagged: { reason },
  };
}

export function registerDuplicateFlowTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_categorize_duplicates",
    "Bin duplicate groups by shape: checksum-exact (SHA1 match), name-size-match (same filename+size only, weaker), resolution-variants, burst-sequence, edits, unknown. Returns counts plus up to 3 sample groups per category.",
    {},
    async () => {
      try {
        const raw = await sdk.getAssetDuplicates();
        const groups = raw as unknown as DupGroup[];
        const cats: Record<Category, DupGroup[]> = {
          "checksum-exact": [],
          "name-size-match": [],
          "resolution-variants": [],
          "burst-sequence": [],
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
    "Return ready-to-trash candidates inside Immich CLIP duplicate groups. v0.5.0: prefer the `safetyMode` input ('strict-checksum' default, 'clip-name-size-time', 'clip-only'). Deprecated `matchMode: 'checksum'` still works as an alias for `safetyMode: 'strict-checksum'`; `matchMode: 'name-size'` returns a deprecation error. Album-aware: buckets with multiple in-album assets are flagged for manual review.",
    {
      minSizeBytes: z.number().int().min(0).optional(),
      albumAware: z.boolean().optional(),
      detailLimit: z.number().int().min(1).max(500).optional(),
      webBaseUrl: webBaseUrlSchema.optional(),
      safetyMode: z.enum(["strict-checksum", "clip-name-size-time", "clip-only"]).optional(),
      matchMode: z.enum(["checksum", "name-size"]).optional(),
    },
    async ({ minSizeBytes, albumAware, detailLimit, webBaseUrl, safetyMode, matchMode }) => {
      try {
        const resolved = resolveSafetyMode({ safetyMode, matchMode });
        if (typeof resolved === "object" && "error" in resolved) {
          return asMcpError(resolved.error);
        }
        const mode: SafetyMode = resolved;
        const reason: BucketMatchReason = matchReasonForSafetyMode(mode);
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
          matchReason: BucketMatchReason;
        }> = [];
        const enrichedKept: EnrichedBucket[] = [];
        const flagged: EnrichedBucket[] = [];
        let totalDiscardAssets = 0;
        let totalReclaimable = 0;
        for (const g of groups) {
          const buckets = selectSubgroupsBySafetyMode(g, mode);
          for (const bucket of buckets.values()) {
            const sample = bucket[0]!;
            const fname = sample.originalFileName ?? "";
            const size = fileSize(sample);
            if (size < min) continue;
            const decision = pickKeeperWithAlbums(bucket, "oldest", albumIndex, aware);
            if (decision.flagged) {
              flagged.push(
                buildFlaggedBucket(g.duplicateId, fname, bucket, albumIndex, reason, webBaseUrl, decision.flagged.reason),
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
              matchReason: reason,
            });
            enrichedKept.push(
              buildEnrichedBucket(g.duplicateId, fname, keeper, discards, reclaim, albumIndex, reason, webBaseUrl),
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
          safetyMode: mode,
          // Back-compat field for v0.4.x callers. Mirrors safetyMode using the
          // closest legacy spelling: strict-checksum echoes as "checksum"; the
          // new modes echo their canonical name (no legacy equivalent exists).
          matchMode: mode === "strict-checksum" ? "checksum" : mode,
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
    "End-to-end dedupe. Dry-run by default. delete: true + writes enabled = soft trash (recoverable). permanent: true + confirm: true = bypass trash. v0.5.0: use `safetyMode` ('strict-checksum' default, 'clip-name-size-time', 'clip-only'); deprecated `matchMode: 'checksum'` still works, `matchMode: 'name-size'` returns a deprecation error. Album-aware skips buckets with split curation.",
    {
      strategy: z.enum(["byte_dupes_keep_oldest", "byte_dupes_keep_largest"]),
      minSizeBytes: z.number().int().min(0).optional(),
      delete: z.boolean().optional(),
      permanent: z.boolean().optional(),
      confirm: z.boolean().optional(),
      maxDiscards: z.number().int().min(1).max(20000).optional(),
      albumAware: z.boolean().optional(),
      detailLimit: z.number().int().min(1).max(500).optional(),
      webBaseUrl: webBaseUrlSchema.optional(),
      exportTo: z.string().optional(),
      safetyMode: z.enum(["strict-checksum", "clip-name-size-time", "clip-only"]).optional(),
      matchMode: z.enum(["checksum", "name-size"]).optional(),
    },
    async (args) => {
      try {
        const resolved = resolveSafetyMode({ safetyMode: args.safetyMode, matchMode: args.matchMode });
        if (typeof resolved === "object" && "error" in resolved) {
          return asMcpError(resolved.error);
        }
        const mode: SafetyMode = resolved;
        const reason: BucketMatchReason = matchReasonForSafetyMode(mode);
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
          for (const bucket of selectSubgroupsBySafetyMode(g, mode).values()) {
            const sample = bucket[0]!;
            const fname = sample.originalFileName ?? "";
            if (fileSize(sample) < min) continue;
            const decision = pickKeeperWithAlbums(bucket, keepBy, albumIndex, aware);
            if (decision.flagged) {
              flagged.push(
                buildFlaggedBucket(g.duplicateId, fname, bucket, albumIndex, reason, webBaseUrl, decision.flagged.reason),
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
              buildEnrichedBucket(g.duplicateId, fname, keeper, discards, reclaimBucket, albumIndex, reason, webBaseUrl),
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
          safetyMode: mode,
          // Back-compat echo: strict-checksum -> "checksum"; new modes keep
          // their canonical name (no legacy equivalent existed).
          matchMode: mode === "strict-checksum" ? "checksum" : mode,
          bucketsResolved: buckets,
          discardCount: discardIds.length,
          reclaimableBytes: reclaim,
          flaggedCount: flagged.length,
        };

        // exportTo is a filesystem write op. It must be gated by IMMICH_ALLOW_WRITES
        // EVEN in dry-run mode (delete: false), since the CSV touches disk.
        let exportPath: string | undefined;
        let exportRowCount: number | undefined;
        if (args.exportTo) {
          requireWrites(config);
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
          safetyMode: mode,
          matchMode: mode === "strict-checksum" ? "checksum" : mode,
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

  server.tool(
    "immich_explain_duplicate_group",
    "Drill into one duplicate group: per-asset metadata, album memberships, recommended keeper with rationale. Use to investigate before bulk action.",
    {
      duplicateId: Uuid,
      webBaseUrl: webBaseUrlSchema.optional(),
    },
    async ({ duplicateId, webBaseUrl }) => {
      try {
        const raw = await withRetry("getAssetDuplicates", () => sdk.getAssetDuplicates());
        const groups = raw as unknown as DupGroup[];
        const target = groups.find((g) => g.duplicateId === duplicateId);
        if (!target) {
          return asMcpError(`Duplicate group ${duplicateId} not found.`);
        }
        const albumIndex = await buildAssetAlbumIndex();
        const enriched = target.assets.map((a) => {
          const ref = enrichAsset(a, albumIndex, webBaseUrl);
          const meta = a as unknown as { isFavorite?: boolean; isArchived?: boolean; rating?: number };
          return {
            ...ref,
            isFavorite: meta.isFavorite ?? false,
            isArchived: meta.isArchived ?? false,
            rating: meta.rating ?? null,
          };
        });
        const matchReason = categorize(target);
        // Recommendation: prefer in-album, then favorite, then highest rating,
        // then oldest, with a final lexicographic id tiebreaker so the result
        // is deterministic across runs even when every signal ties.
        const sorted = [...enriched].sort((a, b) => {
          const aScore = (a.albumIds.length ? 100 : 0) + (a.isFavorite ? 10 : 0) + (a.rating ?? 0);
          const bScore = (b.albumIds.length ? 100 : 0) + (b.isFavorite ? 10 : 0) + (b.rating ?? 0);
          if (aScore !== bScore) return bScore - aScore;
          const created = (a.fileCreatedAt ?? "").localeCompare(b.fileCreatedAt ?? "");
          if (created !== 0) return created;
          return a.id.localeCompare(b.id);
        });
        // Recommendation null when 2+ assets are in albums (split curation; no single dominant keeper).
        const albumCount = enriched.filter((a) => a.albumIds.length > 0).length;
        const top = sorted[0]!;
        const runnerUp = sorted[1];
        // Only include rationale parts that materially favored the winner over
        // the runner-up. If no signal differentiated them, fall back to "oldest"
        // as the pure tiebreaker label.
        const rationaleParts: string[] = [];
        const topAlbumCount = top.albumIds.length;
        const runnerAlbumCount = runnerUp?.albumIds.length ?? 0;
        if (topAlbumCount > runnerAlbumCount) {
          rationaleParts.push(`in ${topAlbumCount} album(s)`);
        }
        if (top.isFavorite && !(runnerUp?.isFavorite ?? false)) {
          rationaleParts.push("favorite");
        }
        if ((top.rating ?? 0) > (runnerUp?.rating ?? 0)) {
          rationaleParts.push(`rating ${top.rating}`);
        }
        if (rationaleParts.length === 0) {
          rationaleParts.push("oldest");
        }
        const recommendation = albumCount > 1
          ? null
          : {
              keeperId: top.id,
              rationale: rationaleParts.join(" + "),
            };
        return asMcpResponse({
          duplicateId,
          total: enriched.length,
          matchReason,
          assets: enriched,
          recommendation,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_find_clip_dupes",
    "Find visual-but-not-byte-identical duplicate pairs (Immich CLIP grouped them but their SHA1 checksums differ). Use to surface cleanup candidates that strict-checksum mode rejects. Pure read; pair with immich_compare_assets for manual review. requireMetadataMatch: true narrows to buckets that also share filename+size+fileCreatedAt.",
    {
      detailLimit: z.number().int().min(1).max(500).optional(),
      webBaseUrl: webBaseUrlSchema.optional(),
      requireMetadataMatch: z.boolean().optional(),
    },
    async (args) => {
      try {
        const detailLimit = args.detailLimit ?? 50;
        const requireMeta = args.requireMetadataMatch ?? false;
        const webBaseUrl = args.webBaseUrl;
        const raw = await withRetry("getAssetDuplicates", () => sdk.getAssetDuplicates());
        const groups = raw as unknown as DupGroup[];
        const buckets: EnrichedBucket[] = [];
        const emptyAlbumIndex = new Map<string, { id: string; name: string }[]>();

        for (const group of groups) {
          // Drop byte-identical members first; they are not "CLIP-only" duplicates.
          const byChecksum = checksumSubgroups(group);
          const checksumMatchedIds = new Set<string>();
          for (const sub of byChecksum.values()) for (const a of sub) checksumMatchedIds.add(a.id);
          const remaining = group.assets.filter((a) => !checksumMatchedIds.has(a.id));
          if (remaining.length < 2) continue;

          // Either narrow to name+size+time subgroups, or treat the whole CLIP
          // group as one bucket.
          const candidateBuckets = requireMeta
            ? clipNameSizeTimeSubgroups({ duplicateId: group.duplicateId, assets: remaining })
            : new Map<string, DupAsset[]>([[group.duplicateId, remaining]]);

          for (const bucket of candidateBuckets.values()) {
            if (bucket.length < 2) continue;
            const sorted = [...bucket].sort(
              (a, b) =>
                (a.fileCreatedAt ?? "").localeCompare(b.fileCreatedAt ?? "") ||
                a.id.localeCompare(b.id),
            );
            const keeper = sorted[0]!;
            const discards = sorted.slice(1);
            const reclaim = discards.reduce((s, d) => s + fileSize(d), 0);
            const matchReason: BucketMatchReason = requireMeta ? "clip-name-size-time" : "clip-only";
            const enriched = buildEnrichedBucket(
              group.duplicateId,
              keeper.originalFileName ?? "",
              keeper,
              discards,
              reclaim,
              emptyAlbumIndex,
              matchReason,
              webBaseUrl,
            );
            enriched.divergence = {
              checksumsDiffer:
                new Set(bucket.map((a) => getChecksum(a) ?? "")).size > 1,
              filenamesDiffer:
                new Set(bucket.map((a) => a.originalFileName ?? "")).size > 1,
              sizesDiffer: new Set(bucket.map(fileSize)).size > 1,
              takenAtDiffer:
                new Set(bucket.map((a) => a.fileCreatedAt ?? "")).size > 1,
            };
            buckets.push(enriched);
          }
        }

        const sortedBuckets = [...buckets].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
        const topByReclaim = sortedBuckets.slice(0, detailLimit);
        const rest = sortedBuckets.slice(detailLimit);
        const tailSample = deterministicTailSample(rest, 10);
        const totalReclaim = buckets.reduce((s, b) => s + b.reclaimableBytes, 0);
        const totalDiscards = buckets.reduce((s, b) => s + b.discards.length, 0);
        const recommendation = buckets.length === 0
          ? "No visual-not-byte duplicate buckets found in the Immich duplicate groups."
          : `Found ${buckets.length} CLIP-grouped bucket(s) with ~${(totalReclaim / 1e9).toFixed(2)} GB potential reclaim. Review with immich_compare_assets before bulk action. Use immich_resolve_with_keep_strategy safetyMode='${requireMeta ? "clip-name-size-time" : "clip-only"}' to act on them.`;

        return asMcpResponse({
          requireMetadataMatch: requireMeta,
          totalBuckets: buckets.length,
          totalDiscardAssets: totalDiscards,
          totalReclaimableBytes: totalReclaim,
          topByReclaim,
          tailSample,
          recommendation,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_compare_assets",
    "Side-by-side metadata comparison of 2-10 assets. Returns per-asset checksum, size, EXIF, taken-at, location, albums, plus a top-level divergence summary and a one-line recommendation. Use for manual verification before bulk dedup action.",
    {
      assetIds: z.array(Uuid).min(2).max(10),
      webBaseUrl: webBaseUrlSchema.optional(),
    },
    async ({ assetIds, webBaseUrl }) => {
      try {
        const fetched = await Promise.all(
          assetIds.map((id) =>
            withRetry(`getAssetInfo:${id}`, () => sdk.getAssetInfo({ id })),
          ),
        );
        const albumIndex = await buildAssetAlbumIndex();
        const assets = fetched.map((raw) => {
          const a = raw as unknown as {
            id: string;
            originalFileName?: string;
            fileCreatedAt?: string;
            fileModifiedAt?: string;
            originalPath?: string;
            type?: string;
            duration?: string;
            isFavorite?: boolean;
            isArchived?: boolean;
            isTrashed?: boolean;
            checksum?: string;
            exifInfo?: {
              fileSizeInByte?: number;
              make?: string;
              model?: string;
              dateTimeOriginal?: string;
              latitude?: number;
              longitude?: number;
              city?: string;
              country?: string;
              fNumber?: number;
              focalLength?: number;
              iso?: number;
              exposureTime?: string;
            };
          };
          const albums = (albumIndex.get(a.id) ?? []).map((al) => ({ id: al.id, name: al.name }));
          return {
            id: a.id,
            filename: a.originalFileName ?? "",
            size: Number(a.exifInfo?.fileSizeInByte ?? 0),
            checksum: a.checksum ?? "",
            fileCreatedAt: a.fileCreatedAt,
            fileModifiedAt: a.fileModifiedAt,
            originalPath: a.originalPath,
            type: a.type,
            duration: a.duration,
            isFavorite: a.isFavorite ?? false,
            isArchived: a.isArchived ?? false,
            isTrashed: a.isTrashed ?? false,
            exif: {
              make: a.exifInfo?.make,
              model: a.exifInfo?.model,
              dateTimeOriginal: a.exifInfo?.dateTimeOriginal,
              latitude: a.exifInfo?.latitude,
              longitude: a.exifInfo?.longitude,
              city: a.exifInfo?.city,
              country: a.exifInfo?.country,
              fNumber: a.exifInfo?.fNumber,
              focalLength: a.exifInfo?.focalLength,
              iso: a.exifInfo?.iso,
              exposureTime: a.exifInfo?.exposureTime,
            },
            albums,
            webUrl: buildWebUrl(webBaseUrl, a.id),
          };
        });

        const divergence = {
          checksumsDiffer: new Set(assets.map((a) => a.checksum)).size > 1,
          filenamesDiffer: new Set(assets.map((a) => a.filename)).size > 1,
          sizesDiffer: new Set(assets.map((a) => a.size)).size > 1,
          takenAtDiffer: new Set(assets.map((a) => a.fileCreatedAt ?? "")).size > 1,
          locationsDiffer:
            new Set(assets.map((a) => `${a.exif.latitude ?? ""}|${a.exif.longitude ?? ""}`)).size > 1,
          devicesDiffer:
            new Set(assets.map((a) => `${a.exif.make ?? ""}|${a.exif.model ?? ""}`)).size > 1,
        };

        let recommendation: string;
        if (!divergence.checksumsDiffer) {
          recommendation =
            "All assets are byte-identical (same SHA1). Safe to dedupe with safetyMode='strict-checksum'.";
        } else if (
          !divergence.filenamesDiffer &&
          !divergence.sizesDiffer &&
          !divergence.takenAtDiffer
        ) {
          recommendation =
            "Assets share filename, size, and taken-at but have different SHA1s. Likely re-encodes or re-imports of the same source. Safe candidate for safetyMode='clip-name-size-time'.";
        } else if (divergence.devicesDiffer || divergence.locationsDiffer) {
          recommendation =
            "Assets differ on device or location metadata. NOT recommended to dedupe; these are likely distinct captures.";
        } else {
          recommendation =
            "Mixed signals. Eyeball each asset's webUrl before any bulk action.";
        }

        return asMcpResponse({ assets, divergence, recommendation });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_audit_active",
    "Find CLIP-grouped duplicate candidates STILL in the active library (post-cleanup housekeeping). Defaults skip assets that are in albums or marked favorite. safetyMode defaults to 'clip-name-size-time'. Returns reclaim estimate, skipped counts, and a recommendation string.",
    {
      safetyMode: z.enum(["clip-name-size-time", "clip-only"]).optional(),
      excludeAlbumAssets: z.boolean().optional(),
      excludeFavorites: z.boolean().optional(),
      detailLimit: z.number().int().min(1).max(500).optional(),
      webBaseUrl: webBaseUrlSchema.optional(),
    },
    async (args) => {
      try {
        const mode: SafetyMode = args.safetyMode ?? "clip-name-size-time";
        const skipAlbums = args.excludeAlbumAssets ?? true;
        const skipFavs = args.excludeFavorites ?? true;
        const detailLimit = args.detailLimit ?? 50;
        const webBaseUrl = args.webBaseUrl;

        const raw = await withRetry("getAssetDuplicates", () => sdk.getAssetDuplicates());
        const groups = raw as unknown as DupGroup[];
        const albumIndex = skipAlbums
          ? await buildAssetAlbumIndex()
          : new Map<string, { id: string; name: string }[]>();

        let skippedAlbum = 0;
        let skippedFav = 0;
        const buckets: EnrichedBucket[] = [];
        const reason: BucketMatchReason = matchReasonForSafetyMode(mode);

        for (const group of groups) {
          const subgroups = selectSubgroupsBySafetyMode(group, mode);
          for (const sub of subgroups.values()) {
            const filtered = sub.filter((a) => {
              const meta = a as unknown as { isFavorite?: boolean; isTrashed?: boolean };
              if (meta.isTrashed === true) return false; // active only
              const inAlbum = (albumIndex.get(a.id) ?? []).length > 0;
              if (skipAlbums && inAlbum) {
                skippedAlbum++;
                return false;
              }
              if (skipFavs && meta.isFavorite === true) {
                skippedFav++;
                return false;
              }
              return true;
            });
            if (filtered.length < 2) continue;
            const sorted = [...filtered].sort(
              (a, b) =>
                (a.fileCreatedAt ?? "").localeCompare(b.fileCreatedAt ?? "") ||
                a.id.localeCompare(b.id),
            );
            const keeper = sorted[0]!;
            const discards = sorted.slice(1);
            const reclaim = discards.reduce((s, d) => s + fileSize(d), 0);
            buckets.push(
              buildEnrichedBucket(
                group.duplicateId,
                keeper.originalFileName ?? "",
                keeper,
                discards,
                reclaim,
                albumIndex,
                reason,
                webBaseUrl,
              ),
            );
          }
        }

        const sortedBuckets = [...buckets].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
        const topByReclaim = sortedBuckets.slice(0, detailLimit);
        const totalReclaim = buckets.reduce((s, b) => s + b.reclaimableBytes, 0);
        const totalDiscards = buckets.reduce((s, b) => s + b.discards.length, 0);
        const recommendation = buckets.length === 0
          ? `No housekeeping candidates found in active library (safetyMode: ${mode}).`
          : `${buckets.length} candidate bucket(s) in active library, ~${(totalReclaim / 1e9).toFixed(2)} GB potential reclaim. ${skippedAlbum} asset(s) skipped because they are in albums; ${skippedFav} skipped because favorited. Review with immich_compare_assets, then act with immich_resolve_with_keep_strategy safetyMode='${mode}'.`;

        return asMcpResponse({
          safetyMode: mode,
          totalBuckets: buckets.length,
          totalDiscardAssets: totalDiscards,
          totalReclaimableBytes: totalReclaim,
          skippedDueToAlbum: skippedAlbum,
          skippedDueToFavorite: skippedFav,
          topByReclaim,
          recommendation,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_audit_trash",
    "Cross-check every trashed asset against the active library. Reports orphans (trashed assets with no byte-identical sibling in active) so you can spot potentially-unique content before permanent deletion. Default matchMode: 'checksum' (true SHA1 byte-identity). 'name-size' is the v0.3-v0.4.1 heuristic.",
    {
      matchMode: z.enum(["checksum", "name-size"]).optional(),
      exportTo: z.string().optional(),
      webBaseUrl: webBaseUrlSchema.optional(),
    },
    async (args) => {
      try {
        const mode: MatchMode = args.matchMode ?? "checksum";

        // searchAssets uses an epoch-zero trashedAfter sentinel + withDeleted
        // to scope to trash. Post-filter is belt-and-suspenders in case the
        // server broadens trashedAfter semantics in a future release.
        const TRASH_SENTINEL = "1970-01-01T00:00:00.000Z";

        const trashed: DupAsset[] = [];
        let page = 1;
        while (true) {
          const r = await withRetry("searchAssets:trash", () =>
            sdk.searchAssets({
              metadataSearchDto: {
                withDeleted: true,
                trashedAfter: TRASH_SENTINEL,
                size: 1000,
                page,
              } as never,
            }),
          );
          const items = (
            (r as unknown as { assets?: { items?: DupAsset[] } }).assets?.items ?? []
          ).filter((a) => (a as unknown as { isTrashed?: boolean }).isTrashed === true);
          if (items.length === 0) break;
          trashed.push(...items);
          if (items.length < 1000) break;
          page++;
          if (page > 60) break; // safety bound: 60k assets max
        }

        const active: DupAsset[] = [];
        page = 1;
        while (true) {
          const r = await withRetry("searchAssets:active", () =>
            sdk.searchAssets({ metadataSearchDto: { size: 1000, page } as never }),
          );
          // Defensive belt-and-suspenders: exclude anything still marked
          // isTrashed in case the server or SDK returns trashed items in the
          // default (no-withDeleted) search.
          const items = (
            (r as unknown as { assets?: { items?: DupAsset[] } }).assets?.items ?? []
          ).filter((a) => (a as unknown as { isTrashed?: boolean }).isTrashed !== true);
          if (items.length === 0) break;
          active.push(...items);
          if (items.length < 1000) break;
          page++;
          if (page > 60) break;
        }

        // Build active-index using the same key formula as the trash lookup.
        const keyOf = (a: DupAsset): string | null => {
          if (mode === "checksum") {
            const ck = getChecksum(a);
            return ck ? ck : null;
          }
          const fn = a.originalFileName ?? "";
          const sz = fileSize(a);
          return `${fn}|${sz}`;
        };
        const activeIndex = new Set<string>();
        for (const a of active) {
          const k = keyOf(a);
          if (k) activeIndex.add(k);
        }

        // Triage each trashed asset.
        const orphans: Array<{
          id: string;
          filename: string;
          size: number;
          fileCreatedAt?: string;
          checksum?: string;
          webUrl?: string;
        }> = [];
        let confirmed = 0;
        const webBase = args.webBaseUrl ? args.webBaseUrl.replace(/\/?$/, "/") : undefined;
        for (const t of trashed) {
          const k = keyOf(t);
          if (k && activeIndex.has(k)) {
            confirmed++;
          } else {
            orphans.push({
              id: t.id,
              filename: t.originalFileName ?? "",
              size: fileSize(t),
              fileCreatedAt: t.fileCreatedAt,
              checksum: getChecksum(t),
              webUrl: webBase
                ? new URL(`photos/${encodeURIComponent(t.id)}`, webBase).toString()
                : undefined,
            });
          }
        }

        // Optional CSV export. Same write-gate + wx flag + formula-injection
        // guard as immich_resolve_with_keep_strategy's exportTo.
        let exportPath: string | undefined;
        let exportRowCount: number | undefined;
        if (args.exportTo) {
          requireWrites(config);
          const header = "trashedId,filename,sizeBytes,checksum,fileCreatedAt,status";
          const body = trashed
            .map((t) => {
              const k = keyOf(t);
              const status = k && activeIndex.has(k) ? "confirmed-byte-identical" : "ORPHAN-NO-MATCH";
              return [
                t.id,
                t.originalFileName ?? "",
                fileSize(t),
                getChecksum(t) ?? "",
                t.fileCreatedAt ?? "",
                status,
              ]
                .map(csvEscape)
                .join(",");
            })
            .join("\n");
          const content = body.length > 0 ? header + "\n" + body + "\n" : header + "\n";

          // Parent-dir + wx semantics, mirroring writePlanCsv.
          const absPath = resolvePath(args.exportTo);
          const parent = dirname(absPath);
          try {
            const stat = await fs.stat(parent);
            if (!stat.isDirectory()) {
              throw new Error(`exportTo parent path is not a directory: ${parent}`);
            }
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
              throw new Error(`exportTo parent directory does not exist: ${parent}`);
            }
            throw e;
          }
          try {
            await fs.writeFile(absPath, content, { encoding: "utf8", flag: "wx" });
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              throw new Error(`exportTo target already exists (refusing to overwrite): ${absPath}`);
            }
            throw e;
          }
          exportPath = absPath;
          exportRowCount = trashed.length;
        }

        const recommendation = orphans.length === 0
          ? `All ${confirmed} trashed assets have ${mode === "checksum" ? "byte-identical (SHA1)" : "name+size"} siblings in the active library. Safe to empty trash (or wait for the 30-day auto-empty).`
          : `${orphans.length} of ${trashed.length} trashed assets have NO ${mode === "checksum" ? "byte-identical (SHA1)" : "name+size"} sibling in active (potentially unique content). Investigate before emptying trash. Use immich_restore_by_query (or restore via Immich web UI > Library > Trash) to recover anything you still want.`;

        return asMcpResponse({
          matchMode: mode,
          totalTrashed: trashed.length,
          confirmedSafeToDelete: confirmed,
          orphansCount: orphans.length,
          orphans: orphans.slice(0, 50),
          ...(exportPath ? { exportPath, exportRowCount } : {}),
          recommendation,
        });
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
