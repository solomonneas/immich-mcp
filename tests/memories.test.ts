import { describe, it, expect, beforeEach } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools } from "../src/tools/memories.js";

const cfg = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const UUID_A = "00000000-0000-0000-0000-000000000001";

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

describe("memory tools", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerMemoryTools(server, cfg);
  });
  it("immich_list_memories calls searchMemories", async () => {
    mockSdkResponse("searchMemories", []);
    await callTool(server, "immich_list_memories", { isTrashed: false });
    expect(sdkCalls[0]?.fn).toBe("searchMemories");
  });
  it("immich_get_memory calls getMemory", async () => {
    mockSdkResponse("getMemory", { id: UUID_A });
    await callTool(server, "immich_get_memory", { id: UUID_A });
    expect(sdkCalls[0]?.fn).toBe("getMemory");
  });
});
