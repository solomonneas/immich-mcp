import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDuplicateFlowTools,
  buildAssetAlbumIndex,
  pickKeeperWithAlbums,
  RESTORE_NOTE,
} from "../src/tools/duplicate-flows.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

// mkAsset defaults checksum to a deterministic synthetic value derived from
// (name, size). Two assets that share filename and size therefore also share
// checksum by default, which matches the v0.4.2 "checksum" default mode for
// the typical fixtures that test the keep-oldest / album-aware logic without
// caring about checksum-vs-name-size semantics specifically. Pass an explicit
// `checksum` to override (e.g. to model the SHA1-distinct-but-name-collision
// scenario that motivated v0.4.2).
const mkAsset = (
  id: string,
  name: string,
  size: number,
  when: string,
  checksum?: string,
) => ({
  id,
  originalFileName: name,
  fileCreatedAt: when,
  exifInfo: { fileSizeInByte: size },
  checksum: checksum ?? `sha1-${name}-${size}`,
});

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function parsePayload(out: unknown): Record<string, unknown> {
  const r = out as ToolResult;
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("duplicate-flows", () => {
  describe("immich_categorize_duplicates", () => {
    it("bins 5 synthetic groups into the right categories with hyphenated keys", async () => {
      resetFakeSdk();
      const groups = [
        // byte-exact: same name + size
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "IMG_0001.jpg", 1024, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "IMG_0001.jpg", 1024, "2024-01-02T00:00:00Z"),
          ],
        },
        // resolution-variants: 1080p/4k pattern
        {
          duplicateId: "g2",
          assets: [
            mkAsset("b1", "movie_1080p.mp4", 1000, "2024-02-01T00:00:00Z"),
            mkAsset("b2", "movie_4k.mp4", 5000, "2024-02-01T00:00:00Z"),
          ],
        },
        // burst-sequence: same YYYYMMDD_HHMMSS prefix
        {
          duplicateId: "g3",
          assets: [
            mkAsset("c1", "20240301_120000_001.jpg", 2000, "2024-03-01T00:00:00Z"),
            mkAsset("c2", "20240301_120000_002.jpg", 2100, "2024-03-01T00:00:00Z"),
          ],
        },
        // edits: " - Copy." pattern
        {
          duplicateId: "g4",
          assets: [
            mkAsset("d1", "photo.jpg", 3000, "2024-04-01T00:00:00Z"),
            mkAsset("d2", "photo - Copy.jpg", 3050, "2024-04-02T00:00:00Z"),
          ],
        },
        // unknown
        {
          duplicateId: "g5",
          assets: [
            mkAsset("e1", "alpha.jpg", 4000, "2024-05-01T00:00:00Z"),
            mkAsset("e2", "beta.jpg", 4100, "2024-05-02T00:00:00Z"),
          ],
        },
      ];
      mockSdkResponse("getAssetDuplicates", groups);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_categorize_duplicates");
      const body = parsePayload(out);
      expect(body.total).toBe(5);
      const byCategory = body.byCategory as Record<string, number>;
      // v0.4.2: byte-exact split into checksum-exact (SHA1 match) and
      // name-size-match (same name+size only). mkAsset defaults checksum to a
      // deterministic synthetic derived from (name, size), so the paired
      // (IMG_0001.jpg, 1024) assets in g1 share checksum and land in
      // checksum-exact.
      expect(byCategory["checksum-exact"]).toBe(1);
      expect(byCategory["name-size-match"]).toBe(0);
      expect(byCategory["resolution-variants"]).toBe(1);
      expect(byCategory["burst-sequence"]).toBe(1);
      expect(byCategory.edits).toBe(1);
      expect(byCategory.unknown).toBe(1);
      // Old aliases are gone.
      expect(byCategory["byte-exact"]).toBeUndefined();
      expect(byCategory.byte_exact).toBeUndefined();
      expect(byCategory.resolution_variants).toBeUndefined();
      expect(byCategory.burst_sequence).toBeUndefined();
    });

    it("v0.4.2: a group with matching name+size but DISTINCT checksums lands in name-size-match", async () => {
      resetFakeSdk();
      const groups = [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "IMG.jpg", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("a2", "IMG.jpg", 1024, "2024-01-02T00:00:00Z", "sha1-BBB"),
          ],
        },
      ];
      mockSdkResponse("getAssetDuplicates", groups);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_categorize_duplicates");
      const body = parsePayload(out);
      const byCategory = body.byCategory as Record<string, number>;
      expect(byCategory["checksum-exact"]).toBe(0);
      expect(byCategory["name-size-match"]).toBe(1);
    });
  });

  describe("immich_find_byte_dupes", () => {
    it("returns 0 candidates when no (name,size) bucket has >=2 assets", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "one.jpg", 100, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "two.jpg", 200, "2024-01-02T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes");
      const body = parsePayload(out);
      expect(body.totalCandidates).toBe(0);
      expect(body.candidates).toEqual([]);
    });

    it("returns 1 candidate with right keeperId and discardIds for a paired bucket", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("newer", "same.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("older", "same.jpg", 500, "2024-01-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes");
      const body = parsePayload(out);
      expect(body.totalCandidates).toBe(1);
      const candidates = body.candidates as Array<{ keeperId: string; discardIds: string[]; reclaimableBytes: number; filename: string; size: number }>;
      expect(candidates[0]!.keeperId).toBe("older");
      expect(candidates[0]!.discardIds).toEqual(["newer"]);
      expect(candidates[0]!.reclaimableBytes).toBe(500);
      expect(candidates[0]!.filename).toBe("same.jpg");
      expect(candidates[0]!.size).toBe(500);
      expect(body.totalDiscardAssets).toBe(1);
      expect(body.totalReclaimableBytes).toBe(500);
    });

    it("respects minSizeBytes filter", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "small.jpg", 100, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "small.jpg", 100, "2024-01-02T00:00:00Z"),
          ],
        },
        {
          duplicateId: "g2",
          assets: [
            mkAsset("b1", "big.jpg", 5000, "2024-01-01T00:00:00Z"),
            mkAsset("b2", "big.jpg", 5000, "2024-01-02T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { minSizeBytes: 1000 });
      const body = parsePayload(out);
      expect(body.totalCandidates).toBe(1);
      const candidates = body.candidates as Array<{ filename: string }>;
      expect(candidates[0]!.filename).toBe("big.jpg");
    });

    it("v0.4.1: fail-fast when getAllAlbums throws (album-aware default)", async () => {
      // With albumAware=true (default), an albums-index failure must surface
      // as an MCP error so the caller does not silently fall back to a
      // strategy-only keeper pick that could trash curated assets.
      resetFakeSdk();
      const { mockSdkError } = await import("./_fake-sdk.js");
      mockSdkError("getAllAlbums", new Error("Immich API 500: server boom"));
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "same.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "same.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes") as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/boom/);
    });
  });

  describe("immich_resolve_with_keep_strategy", () => {
    const dupeFixture = [
      {
        duplicateId: "g1",
        assets: [
          mkAsset("newer", "same.jpg", 500, "2024-06-01T00:00:00Z"),
          mkAsset("older", "same.jpg", 500, "2024-01-01T00:00:00Z"),
        ],
      },
    ];

    it("defaults to dry-run (no SDK delete)", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", dupeFixture);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
      }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.dryRun).toBe(true);
      expect(sdkCalls.some((c) => c.fn === "deleteAssets")).toBe(false);
    });

    it("delete: true with writes disabled returns WriteDisabledError", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", dupeFixture);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        delete: true,
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
    });

    it("delete: true + permanent: true without confirm returns ConfirmRequiredError", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", dupeFixture);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgWrite);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        delete: true,
        permanent: true,
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/confirm: true/);
    });

    it("delete: true, permanent: false (trash) calls deleteAssets with force:false and right ids", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", dupeFixture);
      mockSdkResponse("deleteAssets", undefined);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgWrite);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        delete: true,
      }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const delCall = sdkCalls.find((c) => c.fn === "deleteAssets");
      expect(delCall).toBeDefined();
      const arg = (delCall!.args[0] as { assetBulkDeleteDto: { ids: string[]; force: boolean } }).assetBulkDeleteDto;
      expect(arg.ids).toEqual(["newer"]);
      expect(arg.force).toBe(false);
      const body = parsePayload(out);
      expect(body.executed).toBe(true);
      expect(body.deletedCount).toBe(1);
      expect(body.permanent).toBe(false);
    });

    it("refuses when discardCount > maxDiscards", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      // Build a fixture with 3 discards
      const groups = [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k", "f.jpg", 100, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "f.jpg", 100, "2024-06-01T00:00:00Z"),
            mkAsset("d2", "f.jpg", 100, "2024-07-01T00:00:00Z"),
            mkAsset("d3", "f.jpg", 100, "2024-08-01T00:00:00Z"),
          ],
        },
      ];
      mockSdkResponse("getAssetDuplicates", groups);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgWrite);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        delete: true,
        maxDiscards: 2,
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/exceeds maxDiscards/);
      expect(sdkCalls.some((c) => c.fn === "deleteAssets")).toBe(false);
    });

    it("dry-run response includes restoreNote", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("newer", "same.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("older", "same.jpg", 500, "2024-01-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
      });
      const body = parsePayload(out);
      expect(body.dryRun).toBe(true);
      expect(body.restoreNote).toBe(RESTORE_NOTE);
      expect(typeof body.restoreNote).toBe("string");
      expect((body.restoreNote as string).length).toBeGreaterThan(0);
    });
  });

  describe("immich_find_byte_dupes matchReason", () => {
    it("v0.4.2: returns matchReason: checksum-exact on each candidate under default mode", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "same.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "same.jpg", 500, "2024-01-02T00:00:00Z"),
          ],
        },
        {
          duplicateId: "g2",
          assets: [
            mkAsset("b1", "other.jpg", 700, "2024-02-01T00:00:00Z"),
            mkAsset("b2", "other.jpg", 700, "2024-02-02T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes");
      const body = parsePayload(out);
      expect(body.matchMode).toBe("checksum");
      const candidates = body.candidates as Array<{ matchReason: string }>;
      expect(candidates.length).toBe(2);
      for (const c of candidates) {
        expect(c.matchReason).toBe("checksum-exact");
      }
    });
  });

  describe("buildAssetAlbumIndex", () => {
    it("builds the right map from mocked getAllAlbums + getAlbumInfo", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [
        { id: "alb-1", albumName: "Vacation" },
        { id: "alb-2", albumName: "Family" },
      ]);
      // _fake-sdk only stores one response per fn, so getAlbumInfo returns the same
      // payload for both album fetches. Use a single album in the in-album set.
      mockSdkResponse("getAlbumInfo", {
        albumName: "Vacation",
        assets: [{ id: "asset-a" }, { id: "asset-b" }],
      });
      const idx = await buildAssetAlbumIndex();
      // Both album fetches return the same fixture, so each asset ends up tagged twice.
      expect(idx.get("asset-a")!.length).toBe(2);
      expect(idx.get("asset-b")!.length).toBe(2);
      // Album ids come from the parent loop's `album` (alb-1 first, then alb-2).
      expect(idx.get("asset-a")!.map((x) => x.id).sort()).toEqual(["alb-1", "alb-2"]);
      // Album name resolves from the detail fixture.
      expect(idx.get("asset-a")![0]!.name).toBe("Vacation");
      expect(idx.get("asset-z")).toBeUndefined();
    });

    it("v0.4.1: throws when getAllAlbums throws (fail-fast, not fail-open)", async () => {
      // Before v0.4.1 this silently returned an empty map, which made
      // album-aware callers silently downgrade to strategy-only keeper
      // selection. v0.4.1 lets the error propagate so the tool handler
      // surfaces it as an MCP error.
      resetFakeSdk();
      const { mockSdkError } = await import("./_fake-sdk.js");
      mockSdkError("getAllAlbums", new Error("boom"));
      await expect(buildAssetAlbumIndex()).rejects.toThrow(/boom/);
    });

    it("v0.4.1: throws when getAlbumInfo throws on any individual album", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "A" }]);
      const { mockSdkError } = await import("./_fake-sdk.js");
      mockSdkError("getAlbumInfo", new Error("forbidden"));
      await expect(buildAssetAlbumIndex()).rejects.toThrow(/forbidden/);
    });
  });

  describe("pickKeeperWithAlbums", () => {
    const bucket = [
      mkAsset("a1", "same.jpg", 500, "2024-01-01T00:00:00Z"),
      mkAsset("a2", "same.jpg", 500, "2024-06-01T00:00:00Z"),
      mkAsset("a3", "same.jpg", 500, "2024-12-01T00:00:00Z"),
    ];

    it("picks the in-album asset when exactly one bucket member is in an album", () => {
      const idx = new Map<string, { id: string; name: string }[]>();
      idx.set("a2", [{ id: "alb-x", name: "Album X" }]);
      const result = pickKeeperWithAlbums(bucket, "oldest", idx, true);
      expect(result.keeper?.id).toBe("a2");
      expect(result.flagged).toBeUndefined();
    });

    it("returns flagged when multiple bucket members are in albums", () => {
      const idx = new Map<string, { id: string; name: string }[]>();
      idx.set("a1", [{ id: "alb-x", name: "Album X" }]);
      idx.set("a3", [{ id: "alb-y", name: "Album Y" }]);
      const result = pickKeeperWithAlbums(bucket, "oldest", idx, true);
      expect(result.keeper).toBeNull();
      expect(result.flagged?.reason).toMatch(/2 assets in albums/);
    });

    it("falls back to strategy when no bucket members are in albums", () => {
      const idx = new Map<string, { id: string; name: string }[]>();
      const result = pickKeeperWithAlbums(bucket, "oldest", idx, true);
      // oldest -> 2024-01-01 -> a1
      expect(result.keeper?.id).toBe("a1");
      expect(result.flagged).toBeUndefined();
    });

    it("skips album logic entirely when albumAware is false", () => {
      // Even with multiple in-album assets, albumAware: false uses strategy.
      const idx = new Map<string, { id: string; name: string }[]>();
      idx.set("a1", [{ id: "alb-x", name: "Album X" }]);
      idx.set("a3", [{ id: "alb-y", name: "Album Y" }]);
      const result = pickKeeperWithAlbums(bucket, "largest", idx, false);
      // largest by size, all equal -> first asset (a1).
      expect(result.keeper?.id).toBe("a1");
      expect(result.flagged).toBeUndefined();
    });
  });

  describe("v0.4 enriched output", () => {
    it("immich_find_byte_dupes returns enriched topByReclaim with up to detailLimit buckets", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      // Three buckets with descending reclaimableBytes (different file sizes).
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "a.jpg", 1000, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "a.jpg", 1000, "2024-06-01T00:00:00Z"),
          ],
        },
        {
          duplicateId: "g2",
          assets: [
            mkAsset("k2", "b.jpg", 500, "2024-02-01T00:00:00Z"),
            mkAsset("d2", "b.jpg", 500, "2024-07-01T00:00:00Z"),
          ],
        },
        {
          duplicateId: "g3",
          assets: [
            mkAsset("k3", "c.jpg", 250, "2024-03-01T00:00:00Z"),
            mkAsset("d3", "c.jpg", 250, "2024-08-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { detailLimit: 2 });
      const body = parsePayload(out);
      expect(body.totalCandidates).toBe(3);
      const top = body.topByReclaim as Array<{
        duplicateId: string;
        reclaimableBytes: number;
        keeper: { id: string; albumIds: string[] };
        discards: Array<{ id: string; albumIds: string[] }>;
      }>;
      expect(top.length).toBe(2);
      // Sorted desc by reclaimableBytes: g1 (1000) > g2 (500).
      expect(top[0]!.duplicateId).toBe("g1");
      expect(top[0]!.reclaimableBytes).toBe(1000);
      expect(top[0]!.keeper.id).toBe("k1");
      expect(Array.isArray(top[0]!.keeper.albumIds)).toBe(true);
      expect(top[0]!.discards[0]!.id).toBe("d1");
      expect(top[1]!.duplicateId).toBe("g2");
    });

    it("immich_find_byte_dupes with albumAware flags buckets with multiple in-album members", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "A" }]);
      // Mocked single album payload contains BOTH k1 and d1 -> two in-album bucket members.
      mockSdkResponse("getAlbumInfo", {
        albumName: "A",
        assets: [{ id: "k1" }, { id: "d1" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "x.jpg", 800, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "x.jpg", 800, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { albumAware: true });
      const body = parsePayload(out);
      const flagged = body.flagged as Array<{ duplicateId: string; flagged?: { reason: string } }>;
      expect(flagged.length).toBe(1);
      expect(flagged[0]!.duplicateId).toBe("g1");
      expect(flagged[0]!.flagged?.reason).toMatch(/2 assets in albums/);
      // Candidates should be empty (the only bucket was skipped).
      expect(body.totalCandidates).toBe(0);
      expect(body.candidates).toEqual([]);
    });

    it("immich_find_byte_dupes with webBaseUrl populates webUrl on each enriched asset", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("keep", "p.jpg", 600, "2024-01-01T00:00:00Z"),
            mkAsset("drop", "p.jpg", 600, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", {
        webBaseUrl: "https://photos.x.test/",
      });
      const body = parsePayload(out);
      const top = body.topByReclaim as Array<{
        keeper: { id: string; webUrl?: string };
        discards: Array<{ id: string; webUrl?: string }>;
      }>;
      expect(top[0]!.keeper.webUrl).toBe("https://photos.x.test/photos/keep");
      expect(top[0]!.discards[0]!.webUrl).toBe("https://photos.x.test/photos/drop");
    });

    it("immich_resolve_with_keep_strategy dry-run includes flagged, topByReclaim, tailSample, restoreNote", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
      });
      const body = parsePayload(out);
      expect(body.dryRun).toBe(true);
      expect(Array.isArray(body.flagged)).toBe(true);
      expect(Array.isArray(body.topByReclaim)).toBe(true);
      expect(Array.isArray(body.tailSample)).toBe(true);
      expect(body.restoreNote).toBe(RESTORE_NOTE);
      const plan = body.plan as { flaggedCount: number; bucketsResolved: number };
      expect(plan.flaggedCount).toBe(0);
      expect(plan.bucketsResolved).toBe(1);
    });

    it("immich_resolve_with_keep_strategy with exportTo writes a CSV with header + right row count (writes enabled)", async () => {
      // v0.4.1: exportTo is a filesystem write, gated by IMMICH_ALLOW_WRITES
      // even in dry-run mode. This test uses cfgWrite.
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
        {
          duplicateId: "g2",
          assets: [
            mkAsset("k2", "b.jpg", 200, "2024-02-01T00:00:00Z"),
            mkAsset("d2", "b.jpg", 200, "2024-07-01T00:00:00Z"),
          ],
        },
      ]);
      const csvPath = join(tmpdir(), `immich-mcp-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
      try {
        const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
        registerDuplicateFlowTools(server, cfgWrite);
        const out = await callTool(server, "immich_resolve_with_keep_strategy", {
          strategy: "byte_dupes_keep_oldest",
          exportTo: csvPath,
        });
        const body = parsePayload(out);
        expect(body.exportPath).toBe(csvPath);
        expect(body.exportRowCount).toBe(2);
        const content = await fs.readFile(csvPath, "utf8");
        const lines = content.trim().split("\n");
        expect(lines[0]).toMatch(/^duplicateId,filename,size,reclaimableBytes,matchReason,/);
        // header + 2 data rows
        expect(lines.length).toBe(3);
        // v0.4.2: default matchMode is checksum, so matchReason on rows is checksum-exact.
        expect(lines[1]).toMatch(/^g1,a\.jpg,500,500,checksum-exact,k1,/);
      } finally {
        await fs.unlink(csvPath).catch(() => undefined);
      }
    });

    it("v0.4.1: exportTo with writes DISABLED returns WriteDisabledError even in dry-run", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const csvPath = join(tmpdir(), `immich-mcp-refused-${Date.now()}.csv`);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        exportTo: csvPath,
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
      // And the file was NOT created.
      await expect(fs.stat(csvPath)).rejects.toThrow();
    });

    it("v0.4.1: exportTo to a path whose parent dir does not exist returns a clear error", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const missingDir = join(tmpdir(), `immich-mcp-nope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const csvPath = join(missingDir, "plan.csv");
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgWrite);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        exportTo: csvPath,
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/parent directory does not exist/);
    });

    it("v0.4.1: exportTo to an existing file fails with EEXIST (wx semantics)", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const csvPath = join(tmpdir(), `immich-mcp-exists-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
      await fs.writeFile(csvPath, "pre-existing", "utf8");
      try {
        const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
        registerDuplicateFlowTools(server, cfgWrite);
        const out = await callTool(server, "immich_resolve_with_keep_strategy", {
          strategy: "byte_dupes_keep_oldest",
          exportTo: csvPath,
        }) as ToolResult;
        expect(out.isError).toBe(true);
        expect(out.content[0]!.text).toMatch(/already exists/);
        // Original content is untouched.
        const content = await fs.readFile(csvPath, "utf8");
        expect(content).toBe("pre-existing");
      } finally {
        await fs.unlink(csvPath).catch(() => undefined);
      }
    });

    it("v0.4.1: CSV escapes formula-injection lead chars on filenames", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            // Filename starting with =cmd is the classic CSV-injection vector.
            mkAsset("k1", "=cmd.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "=cmd.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
        {
          duplicateId: "g2",
          assets: [
            // Plus-prefix is also a formula vector in Excel.
            mkAsset("k2", "+leadplus.jpg", 200, "2024-01-01T00:00:00Z"),
            mkAsset("d2", "+leadplus.jpg", 200, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const csvPath = join(tmpdir(), `immich-mcp-injection-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
      try {
        const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
        registerDuplicateFlowTools(server, cfgWrite);
        const out = await callTool(server, "immich_resolve_with_keep_strategy", {
          strategy: "byte_dupes_keep_oldest",
          exportTo: csvPath,
        });
        expect((out as ToolResult).isError).toBeFalsy();
        const content = await fs.readFile(csvPath, "utf8");
        // The dangerous lead char must be prefixed with a single quote BEFORE
        // the cell is quoted/escaped, so spreadsheet apps treat it as text.
        expect(content).toContain("'=cmd.jpg");
        expect(content).toContain("'+leadplus.jpg");
        // And no data row's filename cell starts with a bare =/+/-/@.
        const lines = content.split("\n").slice(1).filter(Boolean);
        for (const line of lines) {
          // Filename is the 2nd column (index 1 after splitting on commas).
          // Cells with leading dangerous chars should NOT appear unquoted at
          // the start of any data row's filename column.
          expect(line).not.toMatch(/^[^,]*,[=+\-@]/);
        }
      } finally {
        await fs.unlink(csvPath).catch(() => undefined);
      }
    });

    it("immich_resolve_with_keep_strategy delete: true permanent: false succeeds AND returns restoreNote", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      mockSdkResponse("deleteAssets", undefined);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgWrite);
      const out = await callTool(server, "immich_resolve_with_keep_strategy", {
        strategy: "byte_dupes_keep_oldest",
        delete: true,
        permanent: false,
      }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.executed).toBe(true);
      expect(body.deletedCount).toBe(1);
      expect(body.permanent).toBe(false);
      expect(body.restoreNote).toBe(RESTORE_NOTE);
    });

    it("albumAware: false skips the album index entirely (no getAllAlbums call)", async () => {
      resetFakeSdk();
      // Intentionally do NOT mock getAllAlbums; if albumAware: false works,
      // the SDK fn is never invoked and the empty default fixture is fine.
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("d", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { albumAware: false });
      const body = parsePayload(out);
      expect(body.totalCandidates).toBe(1);
      // The crucial assertion: no getAllAlbums or getAlbumInfo SDK call happened.
      expect(sdkCalls.some((c) => c.fn === "getAllAlbums")).toBe(false);
      expect(sdkCalls.some((c) => c.fn === "getAlbumInfo")).toBe(false);
    });
  });

  describe("immich_explain_duplicate_group", () => {
    const validId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";

    it("returns a clear error when the duplicateId is not found", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: otherId,
          assets: [
            mkAsset("a1", "a.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "a.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain(validId);
      expect(out.content[0]!.text).toMatch(/not found/i);
    });

    it("with one in-album asset, recommendation.keeperId is that asset and rationale mentions albums", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "Vacation" }]);
      mockSdkResponse("getAlbumInfo", {
        albumName: "Vacation",
        assets: [{ id: "a2" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            mkAsset("a1", "p.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "p.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("a3", "p.jpg", 500, "2024-12-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      expect(body.total).toBe(3);
      const rec = body.recommendation as { keeperId: string; rationale: string };
      expect(rec.keeperId).toBe("a2");
      expect(rec.rationale).toMatch(/album/i);
    });

    it("with multiple in-album assets, recommendation is null", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "A" }]);
      // Mocked single album returns BOTH a1 and a2 -> two in-album bucket members.
      mockSdkResponse("getAlbumInfo", {
        albumName: "A",
        assets: [{ id: "a1" }, { id: "a2" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            mkAsset("a1", "p.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "p.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("a3", "p.jpg", 500, "2024-12-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      expect(body.recommendation).toBeNull();
    });

    it("with no albums but favorites, recommendation prefers favorite", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            { ...mkAsset("a1", "p.jpg", 500, "2024-01-01T00:00:00Z"), isFavorite: false },
            { ...mkAsset("a2", "p.jpg", 500, "2024-06-01T00:00:00Z"), isFavorite: true },
            { ...mkAsset("a3", "p.jpg", 500, "2024-12-01T00:00:00Z"), isFavorite: false },
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      const rec = body.recommendation as { keeperId: string; rationale: string };
      expect(rec.keeperId).toBe("a2");
      expect(rec.rationale).toMatch(/favorite/i);
    });

    it("with no signals, recommendation falls back to oldest", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            mkAsset("a1", "p.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("a2", "p.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a3", "p.jpg", 500, "2024-12-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      const rec = body.recommendation as { keeperId: string; rationale: string };
      // Oldest fileCreatedAt is a2 (2024-01-01).
      expect(rec.keeperId).toBe("a2");
      expect(rec.rationale).toMatch(/oldest/i);
    });

    it("v0.4.1: rationale does NOT include 'oldest' when album signal alone drives the pick", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "Vacation" }]);
      mockSdkResponse("getAlbumInfo", {
        albumName: "Vacation",
        assets: [{ id: "a2" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            // a1 is older, but a2 is the only one in an album. Rationale must
            // not claim "oldest" - that's a lie, it was the album signal.
            mkAsset("a1", "p.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "p.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("a3", "p.jpg", 500, "2024-12-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      const rec = body.recommendation as { keeperId: string; rationale: string };
      expect(rec.keeperId).toBe("a2");
      expect(rec.rationale).toMatch(/in 1 album/);
      expect(rec.rationale).not.toMatch(/oldest/);
    });

    it("v0.4.1: rationale says 'favorite' when only favorite differs (no 'oldest' tail)", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            { ...mkAsset("a1", "p.jpg", 500, "2024-01-01T00:00:00Z"), isFavorite: false },
            // a2 is the only favorite. Tied on everything else. Rationale =
            // "favorite", NOT "favorite + oldest".
            { ...mkAsset("a2", "p.jpg", 500, "2024-06-01T00:00:00Z"), isFavorite: true },
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      const rec = body.recommendation as { keeperId: string; rationale: string };
      expect(rec.keeperId).toBe("a2");
      expect(rec.rationale).toBe("favorite");
    });

    it("v0.4.1: tiebreaker is deterministic on id when all signals tie", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          // All three tie on every signal AND fileCreatedAt. Lex-smallest id wins.
          assets: [
            mkAsset("zz-a", "p.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("aa-a", "p.jpg", 500, "2024-06-01T00:00:00Z"),
            mkAsset("mm-a", "p.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      const rec = body.recommendation as { keeperId: string; rationale: string };
      expect(rec.keeperId).toBe("aa-a");
      expect(rec.rationale).toBe("oldest");
    });

    it("v0.4.2: matchReason on explain output prefers checksum-exact when SHA1 matches", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            mkAsset("a1", "same.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "same.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
      });
      const body = parsePayload(out);
      // mkAsset's synthetic checksum is the same for matching name+size, so
      // the categorize() pass detects a checksum subgroup before falling back
      // to name-size.
      expect(body.matchReason).toBe("checksum-exact");
    });

    it("v0.4.1: webBaseUrl schema rejects 'javascript:' and 'ftp://' (http/https only)", () => {
      // The MCP harness calls handler() directly in these tests, bypassing
      // the JSON-RPC layer's zod validation. Exercise the schema's parse()
      // directly to verify the refinement does the right thing.
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const reg = (server as unknown as { _registeredTools: Record<string, { inputSchema: z.ZodTypeAny }> })._registeredTools;
      const schema = reg["immich_explain_duplicate_group"]!.inputSchema;
      // Valid case (https) passes.
      expect(() =>
        schema.parse({
          duplicateId: validId,
          webBaseUrl: "https://example.com",
        }),
      ).not.toThrow();
      // javascript: is rejected by z.string().url() as "Invalid URL".
      expect(() =>
        schema.parse({
          duplicateId: validId,
          webBaseUrl: "javascript:alert(1)",
        }),
      ).toThrow();
      // ftp: parses as a URL but our refine() blocks non-http(s) schemes.
      expect(() =>
        schema.parse({
          duplicateId: validId,
          webBaseUrl: "ftp://x.example/",
        }),
      ).toThrow(/http/i);
    });

    it("v0.4.1: webUrl encodes asset ids that contain spaces and reserved chars", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: validId,
          assets: [
            mkAsset("weird id", "p.jpg", 500, "2024-01-01T00:00:00Z"),
            mkAsset("normal", "p.jpg", 500, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_explain_duplicate_group", {
        duplicateId: validId,
        webBaseUrl: "https://example.com",
      });
      const body = parsePayload(out);
      const assets = body.assets as Array<{ id: string; webUrl?: string }>;
      const weird = assets.find((a) => a.id === "weird id");
      expect(weird?.webUrl).toBe("https://example.com/photos/weird%20id");
      const normal = assets.find((a) => a.id === "normal");
      expect(normal?.webUrl).toBe("https://example.com/photos/normal");
    });
  });

  describe("v0.4.1 fixes", () => {
    const validId = "11111111-1111-4111-8111-111111111111";

    it("flagged bucket shape: keeper:null, discards:[], members:[...all]", async () => {
      // Two in-album assets -> flagged. Verify shape has no fake keeper or
      // discardIds that downstream tools could misuse.
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "A" }]);
      mockSdkResponse("getAlbumInfo", {
        albumName: "A",
        assets: [{ id: "k1" }, { id: "d1" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "x.jpg", 800, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "x.jpg", 800, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { albumAware: true });
      const body = parsePayload(out);
      const flagged = body.flagged as Array<{
        duplicateId: string;
        keeper: { id: string } | null;
        discards: Array<{ id: string }>;
        members?: Array<{ id: string }>;
        reclaimableBytes: number;
      }>;
      expect(flagged.length).toBe(1);
      const fb = flagged[0]!;
      expect(fb.keeper).toBeNull();
      expect(fb.discards).toEqual([]);
      expect(Array.isArray(fb.members)).toBe(true);
      expect(fb.members!.map((m) => m.id).sort()).toEqual(["d1", "k1"]);
      // Nothing reclaimed because nothing selected.
      expect(fb.reclaimableBytes).toBe(0);
    });

    it("CSV row for a flagged bucket has empty keeperId and discardIds cells", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "A" }]);
      mockSdkResponse("getAlbumInfo", {
        albumName: "A",
        assets: [{ id: "k1" }, { id: "d1" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("k1", "x.jpg", 800, "2024-01-01T00:00:00Z"),
            mkAsset("d1", "x.jpg", 800, "2024-06-01T00:00:00Z"),
          ],
        },
      ]);
      const csvPath = join(tmpdir(), `immich-mcp-flagged-csv-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
      try {
        const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
        registerDuplicateFlowTools(server, cfgWrite);
        const out = await callTool(server, "immich_resolve_with_keep_strategy", {
          strategy: "byte_dupes_keep_oldest",
          exportTo: csvPath,
        });
        expect((out as ToolResult).isError).toBeFalsy();
        const content = await fs.readFile(csvPath, "utf8");
        const lines = content.trim().split("\n");
        // header + one flagged row
        expect(lines.length).toBe(2);
        // Columns: duplicateId, filename, size, reclaimableBytes, matchReason,
        // keeperId, keeperFileCreatedAt, keeperAlbums, discardIds, discardAlbums,
        // flagged, flaggedReason
        const cells = lines[1]!.split(",");
        expect(cells[0]).toBe("g1");
        expect(cells[1]).toBe("x.jpg");
        expect(cells[3]).toBe("0"); // reclaimableBytes
        // v0.4.2: default matchMode "checksum" -> matchReason "checksum-exact"
        expect(cells[4]).toBe("checksum-exact");
        expect(cells[5]).toBe(""); // keeperId
        expect(cells[6]).toBe(""); // keeperFileCreatedAt
        expect(cells[7]).toBe(""); // keeperAlbums
        expect(cells[8]).toBe(""); // discardIds
        expect(cells[10]).toBe("true"); // flagged
      } finally {
        await fs.unlink(csvPath).catch(() => undefined);
      }
    });

    it("tailSample contains the lowest-reclaim buckets, not the first-by-id", async () => {
      // 12 buckets with reclaim sizes 100, 200, ..., 1200. detailLimit=2
      // means the top-2 by reclaim are popped, and tailSample (10) should
      // contain the next 10 lowest-reclaim buckets, NOT the lex-first 10
      // by duplicateId.
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      const groups = [];
      for (let i = 1; i <= 12; i++) {
        const size = i * 100;
        // Lex-order on id by zero-padding so the id sort is well-defined,
        // and prefix with z for low-reclaim ids so they would sort LAST by id
        // if the buggy behavior were still in place.
        const prefix = i <= 3 ? "z" : "a";
        const id = `${prefix}${String(i).padStart(2, "0")}`;
        groups.push({
          duplicateId: `g-${id}`,
          assets: [
            mkAsset(`k-${id}`, `f${i}.jpg`, size, "2024-01-01T00:00:00Z"),
            mkAsset(`d-${id}`, `f${i}.jpg`, size, "2024-06-01T00:00:00Z"),
          ],
        });
      }
      mockSdkResponse("getAssetDuplicates", groups);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { detailLimit: 2 });
      const body = parsePayload(out);
      const top = body.topByReclaim as Array<{ reclaimableBytes: number }>;
      // top-2 are the 1200 and 1100 buckets.
      expect(top.length).toBe(2);
      expect(top[0]!.reclaimableBytes).toBe(1200);
      expect(top[1]!.reclaimableBytes).toBe(1100);
      const tail = body.tailSample as Array<{ reclaimableBytes: number }>;
      // tail (max 10) should contain the remaining 10 buckets sorted ascending
      // by reclaim: 100, 200, 300, ..., 1000.
      expect(tail.length).toBe(10);
      const tailSizes = tail.map((b) => b.reclaimableBytes);
      expect(tailSizes).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    });
  });

  describe("v0.4.2 checksum mode", () => {
    it("matchMode: 'checksum' + matching SHA1 yields candidates with matchReason: checksum-exact", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("older", "same.jpg", 500, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("newer", "same.jpg", 500, "2024-06-01T00:00:00Z", "sha1-AAA"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { matchMode: "checksum" });
      const body = parsePayload(out);
      expect(body.matchMode).toBe("checksum");
      const candidates = body.candidates as Array<{ matchReason: string; keeperId: string; discardIds: string[] }>;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.matchReason).toBe("checksum-exact");
      expect(candidates[0]!.keeperId).toBe("older");
      expect(candidates[0]!.discardIds).toEqual(["newer"]);
    });

    it("matchMode: 'checksum' + same name/size but DISTINCT SHA1 yields ZERO candidates (the v0.4.2 safety win)", async () => {
      // The bug-finding fixture: three videos that share filename + size +
      // timestamp coincidentally, but actually have distinct SHA1 checksums.
      // v0.3-v0.4.1 would have happily trashed two of them. v0.4.2 default
      // must refuse.
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "VID_001.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID_001.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"),
            mkAsset("c", "VID_001.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-CCC"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { matchMode: "checksum" });
      const body = parsePayload(out);
      expect(body.totalCandidates).toBe(0);
      expect(body.candidates).toEqual([]);
      // No flagged either: a checksum subgroup with <2 members is silently
      // dropped before keeper logic runs.
      expect(body.flagged).toEqual([]);
    });

    it("v0.5.0: matchMode: 'name-size' is no longer supported and returns a clear deprecation error", async () => {
      // The v0.3-v0.4.1 unsafe heuristic. In v0.5.0 the caller is redirected
      // to the new safetyMode='clip-name-size-time' (which additionally
      // requires fileCreatedAt to match).
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "VID_001.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID_001.mp4", 1024, "2024-06-01T00:00:00Z", "sha1-BBB"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { matchMode: "name-size" }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/no longer supported/i);
      expect(out.content[0]!.text).toMatch(/clip-name-size-time/);
    });

    it("v0.5.0: matchMode: 'checksum' still works as alias for safetyMode='strict-checksum'", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("older", "same.jpg", 500, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("newer", "same.jpg", 500, "2024-06-01T00:00:00Z", "sha1-AAA"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { matchMode: "checksum" });
      const body = parsePayload(out);
      expect(body.safetyMode).toBe("strict-checksum");
      expect(body.matchMode).toBe("checksum");
      const candidates = body.candidates as Array<{ matchReason: string; keeperId: string }>;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.matchReason).toBe("checksum-exact");
      expect(candidates[0]!.keeperId).toBe("older");
    });
  });

  describe("v0.5.0 safetyMode", () => {
    it("safetyMode: 'strict-checksum' matches checksum-exact behavior", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("older", "same.jpg", 500, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("newer", "same.jpg", 500, "2024-06-01T00:00:00Z", "sha1-AAA"),
            // Distinct SHA1 - should be dropped under strict-checksum.
            mkAsset("third", "same.jpg", 500, "2024-03-01T00:00:00Z", "sha1-BBB"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", {
        safetyMode: "strict-checksum",
      });
      const body = parsePayload(out);
      expect(body.safetyMode).toBe("strict-checksum");
      const candidates = body.candidates as Array<{ matchReason: string; keeperId: string; discardIds: string[] }>;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.matchReason).toBe("checksum-exact");
      expect(candidates[0]!.keeperId).toBe("older");
      // Only the two assets sharing SHA1-AAA are paired; "third" is excluded.
      expect(candidates[0]!.discardIds).toEqual(["newer"]);
    });

    it("safetyMode: 'clip-name-size-time' groups by name+size+fileCreatedAt across distinct checksums", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            // Same name+size+takenAt but distinct SHA1 (the 9,725 case).
            mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"),
            // Same name+size but different takenAt - excluded.
            mkAsset("c", "VID.mp4", 1024, "2024-02-01T00:00:00Z", "sha1-CCC"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", {
        safetyMode: "clip-name-size-time",
      });
      const body = parsePayload(out);
      expect(body.safetyMode).toBe("clip-name-size-time");
      const candidates = body.candidates as Array<{ matchReason: string; keeperId: string; discardIds: string[] }>;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.matchReason).toBe("clip-name-size-time");
      expect(candidates[0]!.keeperId).toBe("a");
      expect(candidates[0]!.discardIds).toEqual(["b"]);
    });

    it("safetyMode: 'clip-only' returns the whole CLIP group as one bucket regardless of checksum/name/time", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "a.jpg", 100, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "b.jpg", 200, "2024-02-01T00:00:00Z", "sha1-BBB"),
            mkAsset("c", "c.jpg", 300, "2024-03-01T00:00:00Z", "sha1-CCC"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_byte_dupes", { safetyMode: "clip-only" });
      const body = parsePayload(out);
      expect(body.safetyMode).toBe("clip-only");
      const candidates = body.candidates as Array<{ matchReason: string; keeperId: string; discardIds: string[] }>;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.matchReason).toBe("clip-only");
      // Keep-oldest -> "a" (earliest fileCreatedAt). Other two are discards.
      expect(candidates[0]!.keeperId).toBe("a");
      expect(candidates[0]!.discardIds.sort()).toEqual(["b", "c"]);
    });
  });

  describe("immich_find_clip_dupes", () => {
    it("excludes byte-identical (checksum-matched) members and returns CLIP-only remainder", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetDuplicates", [
        {
          // Mixed group: two byte-identical + two visually-grouped distinct.
          duplicateId: "g1",
          assets: [
            mkAsset("byte-a", "x.jpg", 100, "2024-01-01T00:00:00Z", "sha1-SAME"),
            mkAsset("byte-b", "x.jpg", 100, "2024-02-01T00:00:00Z", "sha1-SAME"),
            mkAsset("clip-a", "x.jpg", 200, "2024-03-01T00:00:00Z", "sha1-XYZ"),
            mkAsset("clip-b", "x.jpg", 250, "2024-04-01T00:00:00Z", "sha1-QRS"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_clip_dupes");
      const body = parsePayload(out);
      expect(body.totalBuckets).toBe(1);
      const top = body.topByReclaim as Array<{
        keeper: { id: string };
        discards: Array<{ id: string }>;
        matchReason: string;
        divergence: { checksumsDiffer: boolean; sizesDiffer: boolean };
      }>;
      expect(top.length).toBe(1);
      expect(top[0]!.matchReason).toBe("clip-only");
      const memberIds = [top[0]!.keeper.id, ...top[0]!.discards.map((d) => d.id)].sort();
      expect(memberIds).toEqual(["clip-a", "clip-b"]);
      expect(top[0]!.divergence.checksumsDiffer).toBe(true);
      expect(top[0]!.divergence.sizesDiffer).toBe(true);
    });

    it("requireMetadataMatch=true narrows to name+size+time matches and labels matchReason 'clip-name-size-time'", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            // Two share name+size+takenAt with distinct SHA1.
            mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"),
            // Third drops out because takenAt differs.
            mkAsset("c", "VID.mp4", 1024, "2024-02-01T00:00:00Z", "sha1-CCC"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_clip_dupes", {
        requireMetadataMatch: true,
      });
      const body = parsePayload(out);
      expect(body.totalBuckets).toBe(1);
      const top = body.topByReclaim as Array<{
        matchReason: string;
        keeper: { id: string };
        discards: Array<{ id: string }>;
      }>;
      expect(top[0]!.matchReason).toBe("clip-name-size-time");
      expect(top[0]!.keeper.id).toBe("a");
      expect(top[0]!.discards.map((d) => d.id)).toEqual(["b"]);
    });

    it("returns 0 buckets when every duplicate group is fully byte-identical", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "x.jpg", 100, "2024-01-01T00:00:00Z", "sha1-X"),
            mkAsset("b", "x.jpg", 100, "2024-02-01T00:00:00Z", "sha1-X"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_find_clip_dupes");
      const body = parsePayload(out);
      expect(body.totalBuckets).toBe(0);
      expect((body.recommendation as string)).toMatch(/No visual-not-byte/);
    });
  });

  describe("immich_compare_assets", () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";

    function mockTwo(a: Record<string, unknown>, b: Record<string, unknown>): void {
      // _fake-sdk stores ONE response per fn name. We fan out by intercepting
      // the call sequence: pre-seed with `a`, then on the next call return `b`.
      // Simplest path: use a single payload that maps id->payload via a wrapper.
      // But the actual handler uses sdk.getAssetInfo({ id }) twice. The fake
      // stores one response and returns it for both calls. To work around,
      // mock once with a function-style? It uses static value. We override on
      // each call by swapping response between assertions via shifting array.
      // We use sdkResponses queue: replace mock per call with vi spy.
      // Cleaner: use the existing single-response store but key the response
      // by a switch on the arg's id (no built-in support). Use a custom mock.
      const queue = [a, b];
      mockSdkResponse("getAssetInfo", queue);
      // Inject custom dispatcher via per-call switch in the fake: we extend
      // the fake's sdkResponses entry into a function-like behavior by using
      // mockSdkResponse with a sentinel array and adding a small consumer
      // pattern. Simpler: override _fake-sdk by post-mocking getAssetInfo to
      // pop the next item per call.
    }

    it("byte-identical pair (same checksum) -> recommendation says safe with strict-checksum", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      // Both assetInfo calls return the same payload from the shared queue.
      // _fake-sdk returns ONE static response per fn, so we use the same shape
      // for both fetched assets (id is read from the payload, not the call arg).
      const shared = {
        id: "shared",
        originalFileName: "p.jpg",
        fileCreatedAt: "2024-01-01T00:00:00Z",
        checksum: "sha1-SAME",
        exifInfo: { fileSizeInByte: 500, make: "Canon", model: "R5" },
      };
      mockSdkResponse("getAssetInfo", shared);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_compare_assets", { assetIds: [idA, idB] });
      const body = parsePayload(out);
      const divergence = body.divergence as { checksumsDiffer: boolean };
      expect(divergence.checksumsDiffer).toBe(false);
      expect((body.recommendation as string)).toMatch(/strict-checksum/);
      const assets = body.assets as Array<{ checksum: string; albums: unknown[] }>;
      expect(assets.length).toBe(2);
      expect(assets[0]!.checksum).toBe("sha1-SAME");
    });

    it("populates webUrl on each asset when webBaseUrl is provided", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetInfo", {
        id: "any",
        originalFileName: "p.jpg",
        fileCreatedAt: "2024-01-01T00:00:00Z",
        checksum: "sha1-X",
        exifInfo: { fileSizeInByte: 500 },
      });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_compare_assets", {
        assetIds: [idA, idB],
        webBaseUrl: "https://photos.example/",
      });
      const body = parsePayload(out);
      const assets = body.assets as Array<{ webUrl?: string }>;
      expect(assets[0]!.webUrl).toMatch(/^https:\/\/photos\.example\/photos\//);
      expect(assets[1]!.webUrl).toMatch(/^https:\/\/photos\.example\/photos\//);
    });

    it("rejects fewer than 2 ids and more than 10 (zod schema enforced)", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const reg = (server as unknown as { _registeredTools: Record<string, { inputSchema: z.ZodTypeAny }> })._registeredTools;
      const schema = reg["immich_compare_assets"]!.inputSchema;
      expect(() => schema.parse({ assetIds: [idA] })).toThrow();
      // 11 ids overshoots max(10).
      const tooMany = Array.from({ length: 11 }, (_, i) =>
        `${String(i + 1).repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`,
      );
      expect(() => schema.parse({ assetIds: tooMany })).toThrow();
    });
  });

  describe("immich_audit_active", () => {
    it("returns expected CLIP-name-size-time buckets when none are filtered", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_active", {});
      const body = parsePayload(out);
      expect(body.safetyMode).toBe("clip-name-size-time");
      expect(body.totalBuckets).toBe(1);
      expect(body.skippedDueToAlbum).toBe(0);
      expect(body.skippedDueToFavorite).toBe(0);
      const top = body.topByReclaim as Array<{ keeper: { id: string }; discards: Array<{ id: string }> }>;
      expect(top[0]!.keeper.id).toBe("a");
      expect(top[0]!.discards.map((d) => d.id)).toEqual(["b"]);
    });

    it("excludeAlbumAssets: true (default) skips bucket members that are in albums", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", [{ id: "alb-1", albumName: "Curated" }]);
      mockSdkResponse("getAlbumInfo", {
        albumName: "Curated",
        // Asset "b" lives in an album; it must be skipped under default exclude.
        assets: [{ id: "b" }],
      });
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_active", {});
      const body = parsePayload(out);
      // "b" is skipped, the bucket has <2 remaining, the bucket drops.
      expect(body.totalBuckets).toBe(0);
      expect(body.skippedDueToAlbum).toBe(1);
      expect(body.skippedDueToFavorite).toBe(0);
    });

    it("excludeFavorites: true (default) skips favorited assets", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            { ...mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"), isFavorite: false },
            { ...mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"), isFavorite: true },
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_active", {});
      const body = parsePayload(out);
      expect(body.totalBuckets).toBe(0);
      expect(body.skippedDueToFavorite).toBe(1);
      expect(body.skippedDueToAlbum).toBe(0);
    });

    it("excludeAlbumAssets: false bypasses the album exclusion (and the index fetch)", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"),
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_active", {
        excludeAlbumAssets: false,
        excludeFavorites: false,
      });
      const body = parsePayload(out);
      expect(body.totalBuckets).toBe(1);
      // Confirm no album fetches happened.
      expect(sdkCalls.some((c) => c.fn === "getAllAlbums")).toBe(false);
      expect(sdkCalls.some((c) => c.fn === "getAlbumInfo")).toBe(false);
    });

    it("skips trashed assets entirely (active library only)", async () => {
      resetFakeSdk();
      mockSdkResponse("getAllAlbums", []);
      mockSdkResponse("getAssetDuplicates", [
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-AAA"),
            { ...mkAsset("b", "VID.mp4", 1024, "2024-01-01T00:00:00Z", "sha1-BBB"), isTrashed: true },
          ],
        },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_active", {});
      const body = parsePayload(out);
      expect(body.totalBuckets).toBe(0);
      // The trashed asset is silently dropped (not counted as album/fav skip).
      expect(body.skippedDueToAlbum).toBe(0);
      expect(body.skippedDueToFavorite).toBe(0);
    });
  });

  describe("immich_audit_trash", () => {
    // searchAssets returns { assets: { items: [...] } }. Trash pagination
    // post-filters on isTrashed === true. Note: _fake-sdk returns the SAME
    // response for every call to the same fn name, so we have to seed a
    // single response that contains BOTH trashed and active markers and rely
    // on isTrashed post-filter to split them. The audit tool's pagination
    // safety bound (page>60) prevents infinite loops; we keep test fixtures
    // small enough (<1000 items) that the loop terminates on the second page
    // returning <1000 items too.

    it("matchMode 'checksum' + trashed has unique checksum -> 1 orphan, 0 confirmed", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: {
          items: [
            // Trashed orphan: no matching checksum in active.
            { id: "t1", originalFileName: "orphan.jpg", checksum: "sha1-ORPHAN", isTrashed: true, exifInfo: { fileSizeInByte: 100 }, fileCreatedAt: "2024-01-01T00:00:00Z" },
            // Active asset with a different checksum.
            { id: "a1", originalFileName: "other.jpg", checksum: "sha1-OTHER", isTrashed: false, exifInfo: { fileSizeInByte: 200 } },
          ],
        },
      });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_trash", {}) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.matchMode).toBe("checksum");
      expect(body.totalTrashed).toBe(1);
      expect(body.confirmedSafeToDelete).toBe(0);
      expect(body.orphansCount).toBe(1);
      const orphans = body.orphans as Array<{ id: string; checksum: string }>;
      expect(orphans.length).toBe(1);
      expect(orphans[0]!.id).toBe("t1");
      expect(orphans[0]!.checksum).toBe("sha1-ORPHAN");
      expect((body.recommendation as string)).toMatch(/byte-identical/);
    });

    it("matchMode 'checksum' + trashed and active share checksum -> 1 confirmed, 0 orphans", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: {
          items: [
            { id: "t1", originalFileName: "shared.jpg", checksum: "sha1-SHARED", isTrashed: true, exifInfo: { fileSizeInByte: 100 }, fileCreatedAt: "2024-01-01T00:00:00Z" },
            { id: "a1", originalFileName: "shared.jpg", checksum: "sha1-SHARED", isTrashed: false, exifInfo: { fileSizeInByte: 100 } },
          ],
        },
      });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_trash", {}) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.totalTrashed).toBe(1);
      expect(body.confirmedSafeToDelete).toBe(1);
      expect(body.orphansCount).toBe(0);
      expect(body.orphans).toEqual([]);
    });

    it("exportTo with writes ENABLED writes a CSV and returns exportPath/exportRowCount", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: {
          items: [
            { id: "t1", originalFileName: "orphan.jpg", checksum: "sha1-ORPHAN", isTrashed: true, exifInfo: { fileSizeInByte: 100 }, fileCreatedAt: "2024-01-01T00:00:00Z" },
            { id: "t2", originalFileName: "ok.jpg", checksum: "sha1-OK", isTrashed: true, exifInfo: { fileSizeInByte: 200 }, fileCreatedAt: "2024-02-01T00:00:00Z" },
            { id: "a1", originalFileName: "ok.jpg", checksum: "sha1-OK", isTrashed: false, exifInfo: { fileSizeInByte: 200 } },
          ],
        },
      });
      const csvPath = join(tmpdir(), `immich-mcp-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
      try {
        const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
        registerDuplicateFlowTools(server, cfgWrite);
        const out = await callTool(server, "immich_audit_trash", { exportTo: csvPath }) as ToolResult;
        expect(out.isError).toBeFalsy();
        const body = parsePayload(out);
        expect(body.exportPath).toBe(csvPath);
        expect(body.exportRowCount).toBe(2);
        const content = await fs.readFile(csvPath, "utf8");
        const lines = content.trim().split("\n");
        expect(lines[0]).toBe("trashedId,filename,sizeBytes,checksum,fileCreatedAt,status");
        // 1 orphan + 1 confirmed = 2 data rows
        expect(lines.length).toBe(3);
        expect(content).toMatch(/ORPHAN-NO-MATCH/);
        expect(content).toMatch(/confirmed-byte-identical/);
      } finally {
        await fs.unlink(csvPath).catch(() => undefined);
      }
    });

    it("exportTo with writes DISABLED returns WriteDisabledError and does NOT create the file", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: {
          items: [
            { id: "t1", originalFileName: "orphan.jpg", checksum: "sha1-ORPHAN", isTrashed: true, exifInfo: { fileSizeInByte: 100 }, fileCreatedAt: "2024-01-01T00:00:00Z" },
          ],
        },
      });
      const csvPath = join(tmpdir(), `immich-mcp-audit-refused-${Date.now()}.csv`);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerDuplicateFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_audit_trash", { exportTo: csvPath }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
      await expect(fs.stat(csvPath)).rejects.toThrow();
    });
  });
});
