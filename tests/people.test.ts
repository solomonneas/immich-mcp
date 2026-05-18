import { describe, it, expect, beforeEach } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPeopleTools } from "../src/tools/people.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

const UUID_A = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";

describe("people tools - reads", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerPeopleTools(server, cfgRead);
  });
  it("immich_list_people calls getAllPeople", async () => {
    mockSdkResponse("getAllPeople", { people: [], total: 0 });
    await callTool(server, "immich_list_people");
    expect(sdkCalls[0]?.fn).toBe("getAllPeople");
  });
  it("immich_get_person hits getPerson or getPersonStatistics", async () => {
    mockSdkResponse("getPerson", { id: UUID_A, name: "Mom" });
    mockSdkResponse("getPersonStatistics", { id: UUID_A });
    await callTool(server, "immich_get_person", { id: UUID_A });
    const fn = sdkCalls[0]?.fn;
    expect(fn === "getPerson" || fn === "getPersonStatistics").toBe(true);
  });
  it("immich_get_person_assets routes through searchAssets with personIds", async () => {
    mockSdkResponse("searchAssets", { assets: { items: [] } });
    await callTool(server, "immich_get_person_assets", { id: UUID_A });
    const call = sdkCalls.find((c) => c.fn === "searchAssets");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call!.args)).toContain(UUID_A);
  });
});

describe("people tools - gates", () => {
  it("immich_update_person refuses without writes", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerPeopleTools(server, cfgRead);
    const out = await callTool(server, "immich_update_person", { id: UUID_A, name: "Mom" }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
  it("immich_hide_person calls updatePerson with isHidden:true when writes enabled", async () => {
    resetFakeSdk();
    mockSdkResponse("updatePerson", { id: UUID_A, isHidden: true });
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerPeopleTools(server, cfgWrite);
    await callTool(server, "immich_hide_person", { id: UUID_A });
    const call = sdkCalls.find((c) => c.fn === "updatePerson");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call!.args)).toContain("isHidden");
  });
  it("immich_merge_people refuses without confirm", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerPeopleTools(server, cfgWrite);
    const out = await callTool(server, "immich_merge_people", { id: UUID_A, ids: [UUID_B] }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
  it("immich_merge_people with confirm proceeds", async () => {
    resetFakeSdk();
    mockSdkResponse("mergePerson", []);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerPeopleTools(server, cfgWrite);
    const out = await callTool(server, "immich_merge_people", { id: UUID_A, ids: [UUID_B], confirm: true }) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(sdkCalls[0]?.fn).toBe("mergePerson");
  });
});
