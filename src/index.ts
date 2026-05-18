import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "./config.js";
import { initImmichClient } from "./client.js";
import { registerSystemTools } from "./tools/system.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerSearchTools } from "./tools/search.js";
import { registerAlbumTools } from "./tools/albums.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerTagTools } from "./tools/tags.js";
import { registerSharedLinkTools } from "./tools/shared-links.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerMemoryTools } from "./tools/memories.js";
import { registerDuplicateTools } from "./tools/duplicates.js";
import { registerStackTools } from "./tools/stacks.js";
import { registerDuplicateFlowTools } from "./tools/duplicate-flows.js";
import { registerMemoryFlowTools } from "./tools/memory-flows.js";
import { registerAlbumFlowTools } from "./tools/album-flows.js";
import { registerTrashTools } from "./tools/trash.js";
import { registerJobTools } from "./tools/jobs.js";

async function main(): Promise<void> {
  const config = getConfig();
  initImmichClient(config);

  const server = new McpServer({
    name: "immich-mcp",
    version: "0.1.0",
    description:
      "MCP server for Immich. Browse and search photos, manage albums, recognize people, surface memories, resolve duplicates, manage stacks, share links, and comment on activity, all as typed tool calls.",
  });

  registerSystemTools(server, config);
  registerAssetTools(server, config);
  registerSearchTools(server, config);
  registerAlbumTools(server, config);
  registerPeopleTools(server, config);
  registerTagTools(server, config);
  registerSharedLinkTools(server, config);
  registerActivityTools(server, config);
  registerMemoryTools(server, config);
  registerDuplicateTools(server, config);
  registerStackTools(server, config);
  registerDuplicateFlowTools(server, config);
  registerMemoryFlowTools(server, config);
  registerAlbumFlowTools(server, config);
  registerTrashTools(server, config);
  registerJobTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`immich-mcp fatal: ${msg}`);
  process.exit(1);
});
