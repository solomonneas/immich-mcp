import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
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

const mkAsset = (id: string, name: string, size: number, when: string) => ({
  id,
  originalFileName: name,
  fileCreatedAt: when,
  exifInfo: { fileSizeInByte: size },
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
    it("bins 5 synthetic groups into the right categories", async () => {
      resetFakeSdk();
      const groups = [
        // byte_exact: same name + size
        {
          duplicateId: "g1",
          assets: [
            mkAsset("a1", "IMG_0001.jpg", 1024, "2024-01-01T00:00:00Z"),
            mkAsset("a2", "IMG_0001.jpg", 1024, "2024-01-02T00:00:00Z"),
          ],
        },
        // resolution_variants: 1080p/4k pattern
        {
          duplicateId: "g2",
          assets: [
            mkAsset("b1", "movie_1080p.mp4", 1000, "2024-02-01T00:00:00Z"),
            mkAsset("b2", "movie_4k.mp4", 5000, "2024-02-01T00:00:00Z"),
          ],
        },
        // burst_sequence: same YYYYMMDD_HHMMSS prefix
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
      expect(byCategory.byte_exact).toBe(1);
      expect(byCategory.resolution_variants).toBe(1);
      expect(byCategory.burst_sequence).toBe(1);
      expect(byCategory.edits).toBe(1);
      expect(byCategory.unknown).toBe(1);
    });
  });

  describe("immich_find_byte_dupes", () => {
    it("returns 0 candidates when no (name,size) bucket has >=2 assets", async () => {
      resetFakeSdk();
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
    it("returns matchReason: byte-exact on each candidate", async () => {
      resetFakeSdk();
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
      const candidates = body.candidates as Array<{ matchReason: string }>;
      expect(candidates.length).toBe(2);
      for (const c of candidates) {
        expect(c.matchReason).toBe("byte-exact");
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

    it("returns an empty map when getAllAlbums throws", async () => {
      resetFakeSdk();
      const { mockSdkError } = await import("./_fake-sdk.js");
      mockSdkError("getAllAlbums", new Error("boom"));
      const idx = await buildAssetAlbumIndex();
      expect(idx.size).toBe(0);
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

    it("immich_resolve_with_keep_strategy with exportTo writes a CSV with header + right row count", async () => {
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
        registerDuplicateFlowTools(server, cfgRead);
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
        expect(lines[1]).toMatch(/^g1,a\.jpg,500,500,byte-exact,k1,/);
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
});
