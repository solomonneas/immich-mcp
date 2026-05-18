import { describe, it, expect } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTrashTools } from "../src/tools/trash.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };

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

describe("trash", () => {
  describe("immich_list_trash", () => {
    it("calls searchAssets with withDeleted:true and trashedAfter sentinel (NOT isTrashed)", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_list_trash", { size: 50 }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const call = sdkCalls.find((c) => c.fn === "searchAssets");
      expect(call).toBeDefined();
      const dto = (call!.args[0] as { metadataSearchDto: Record<string, unknown> }).metadataSearchDto;
      expect(dto.withDeleted).toBe(true);
      expect(typeof dto.trashedAfter).toBe("string");
      expect(dto.size).toBe(50);
      // critical: must NOT pass the silently-ignored isTrashed flag
      expect("isTrashed" in dto).toBe(false);
    });

    it("post-filters returned items to isTrashed:true only", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: {
          items: [
            { id: "live", isTrashed: false },
            { id: "trashed-1", isTrashed: true },
            { id: "trashed-2", isTrashed: true },
            { id: "no-flag" },
          ],
        },
      });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_list_trash") as ToolResult;
      const body = parsePayload(out) as { assets: { items: Array<{ id: string }> } };
      expect(body.assets.items.map((i) => i.id)).toEqual(["trashed-1", "trashed-2"]);
    });
  });

  describe("immich_restore_by_query", () => {
    it("refuses without writes", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_restore_by_query", { confirm: true }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
    });

    it("refuses with no filter and no confirm", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", {}) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/confirm: true/);
      expect(sdkCalls.some((c) => c.fn === "searchAssets")).toBe(false);
      expect(sdkCalls.some((c) => c.fn === "restoreAssets")).toBe(false);
    });

    it("with a filter, does NOT require confirm", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", { type: "IMAGE" }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.restored).toBe(0);
    });

    it("with confirm:true and no filter, proceeds (and uses sentinel scope)", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", { confirm: true }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const call = sdkCalls.find((c) => c.fn === "searchAssets");
      const dto = (call!.args[0] as { metadataSearchDto: Record<string, unknown> }).metadataSearchDto;
      expect(dto.withDeleted).toBe(true);
      expect(typeof dto.trashedAfter).toBe("string");
      expect("isTrashed" in dto).toBe(false);
    });

    it("returns { restored: 0 } when search returns empty", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", { confirm: true }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.restored).toBe(0);
      expect(sdkCalls.some((c) => c.fn === "restoreAssets")).toBe(false);
    });

    it("calls restoreAssets (NOT updateAssets) with the matched ids", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: {
          items: [
            { id: "a1", isTrashed: true },
            { id: "a2", isTrashed: true },
            { id: "a3", isTrashed: true },
          ],
        },
      });
      mockSdkResponse("restoreAssets", undefined);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", { confirm: true }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const restore = sdkCalls.find((c) => c.fn === "restoreAssets");
      expect(restore).toBeDefined();
      const dto = (restore!.args[0] as { bulkIdsDto: { ids: string[] } }).bulkIdsDto;
      expect(dto.ids).toEqual(["a1", "a2", "a3"]);
      expect(sdkCalls.some((c) => c.fn === "updateAssets")).toBe(false);
      const body = parsePayload(out);
      expect(body.restored).toBe(3);
    });

    it("refuses when match count exceeds maxRestore", async () => {
      resetFakeSdk();
      const items = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, isTrashed: true }));
      mockSdkResponse("searchAssets", { assets: { items } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", { maxRestore: 5, confirm: true }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/exceeds maxRestore/);
      expect(sdkCalls.some((c) => c.fn === "restoreAssets")).toBe(false);
    });
  });

  describe("immich_empty_trash", () => {
    it("refuses without writes", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_empty_trash", { confirm: true }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
    });

    it("refuses without confirm", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_empty_trash", {}) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/confirm: true/);
      expect(sdkCalls.some((c) => c.fn === "emptyTrash")).toBe(false);
    });

    it("with writes + confirm calls emptyTrash", async () => {
      resetFakeSdk();
      mockSdkResponse("emptyTrash", { count: 7 });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_empty_trash", { confirm: true }) as ToolResult;
      expect(out.isError).toBeFalsy();
      expect(sdkCalls.some((c) => c.fn === "emptyTrash")).toBe(true);
      const body = parsePayload(out);
      expect(body.emptied).toBe(true);
    });
  });
});
