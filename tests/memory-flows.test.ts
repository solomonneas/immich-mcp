import { describe, it, expect } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryFlowTools } from "../src/tools/memory-flows.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function parsePayload(out: unknown): Record<string, unknown> {
  const r = out as ToolResult;
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("memory-flows", () => {
  describe("immich_memories_today", () => {
    it("calls searchMemories with $for set to passed date", async () => {
      resetFakeSdk();
      mockSdkResponse("searchMemories", []);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerMemoryFlowTools(server, cfgRead);
      const date = "2026-05-18T12:00:00.000Z";
      const out = await callTool(server, "immich_memories_today", { date });
      const body = parsePayload(out);
      expect(body.date).toBe(date);
      const call = sdkCalls.find((c) => c.fn === "searchMemories");
      expect(call).toBeDefined();
      const arg = call!.args[0] as { $for: string; isTrashed: boolean };
      expect(arg.$for).toBe(date);
      expect(arg.isTrashed).toBe(false);
    });

    it("computes yearLabel: 1 year diff -> '1 year ago', same year -> 'today'", async () => {
      resetFakeSdk();
      mockSdkResponse("searchMemories", [
        { id: "m1", memoryAt: "2025-05-18T00:00:00Z", assets: [{ id: "a1" }] },
        { id: "m2", memoryAt: "2026-05-18T00:00:00Z", assets: [{ id: "b1" }] },
        { id: "m3", memoryAt: "2021-05-18T00:00:00Z", assets: [{ id: "c1" }] },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerMemoryFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_memories_today", { date: "2026-05-18T12:00:00.000Z" });
      const body = parsePayload(out);
      const lanes = body.lanes as Array<{ memoryId: string; yearLabel: string }>;
      expect(lanes).toHaveLength(3);
      expect(lanes[0]!.yearLabel).toBe("1 year ago");
      expect(lanes[1]!.yearLabel).toBe("today");
      expect(lanes[2]!.yearLabel).toBe("5 years ago");
    });

    it("truncates sampleAssetIds to maxAssetsPerLane", async () => {
      resetFakeSdk();
      const assets = Array.from({ length: 10 }, (_, i) => ({ id: `asset-${i}` }));
      mockSdkResponse("searchMemories", [
        { id: "m1", memoryAt: "2025-05-18T00:00:00Z", assets },
      ]);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerMemoryFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_memories_today", {
        date: "2026-05-18T12:00:00.000Z",
        maxAssetsPerLane: 3,
      });
      const body = parsePayload(out);
      const lanes = body.lanes as Array<{ assetCount: number; sampleAssetIds: string[] }>;
      expect(lanes[0]!.assetCount).toBe(10);
      expect(lanes[0]!.sampleAssetIds).toEqual(["asset-0", "asset-1", "asset-2"]);
    });
  });

  describe("immich_daily_digest", () => {
    it("calls getAssetStatistics, searchMemories, and searchAssets in parallel", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetStatistics", { images: 100, videos: 20, total: 120 });
      mockSdkResponse("searchMemories", [{ id: "m1", memoryAt: "2025-05-18T00:00:00Z", assets: [] }]);
      mockSdkResponse("searchAssets", { assets: { items: [{ id: "a1" }, { id: "a2" }] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerMemoryFlowTools(server, cfgRead);
      await callTool(server, "immich_daily_digest");
      const fns = sdkCalls.map((c) => c.fn);
      expect(fns).toContain("getAssetStatistics");
      expect(fns).toContain("searchMemories");
      expect(fns).toContain("searchAssets");
    });

    it("produces a markdown string with the right counts", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetStatistics", { images: 100, videos: 20, total: 120 });
      mockSdkResponse("searchMemories", [
        { id: "m1", memoryAt: "2025-05-18T00:00:00Z", assets: [] },
        { id: "m2", memoryAt: "2024-05-18T00:00:00Z", assets: [] },
      ]);
      mockSdkResponse("searchAssets", { assets: { items: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerMemoryFlowTools(server, cfgRead);
      const out = await callTool(server, "immich_daily_digest", { sinceHours: 48 });
      const body = parsePayload(out);
      expect(body.memoryLaneCount).toBe(2);
      expect(body.recentUploadCount).toBe(3);
      const md = body.markdown as string;
      expect(md).toContain("# Immich daily digest");
      expect(md).toContain("120 assets");
      expect(md).toContain("100 photos");
      expect(md).toContain("20 videos");
      expect(md).toContain("Memory lanes today:** 2");
      expect(md).toContain("last 48h");
      expect(md).toContain("Uploaded in the last 48h:** 3");
    });

    it("filters new uploads by createdAfter (upload time) NOT takenAfter (capture time)", async () => {
      resetFakeSdk();
      mockSdkResponse("getAssetStatistics", { images: 0, videos: 0, total: 0 });
      mockSdkResponse("searchMemories", []);
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerMemoryFlowTools(server, cfgRead);
      await callTool(server, "immich_daily_digest", { sinceHours: 24 });
      const searchCall = sdkCalls.find((c) => c.fn === "searchAssets");
      expect(searchCall).toBeDefined();
      const dto = (searchCall!.args[0] as { metadataSearchDto: Record<string, unknown> }).metadataSearchDto;
      expect(typeof dto.createdAfter).toBe("string");
      expect(dto.takenAfter).toBeUndefined();
    });
  });
});
