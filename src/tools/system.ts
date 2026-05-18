import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { asMcpResponse, asMcpError, surfaceError } from "./_util.js";

export function registerSystemTools(server: McpServer, _config: Config): void {
  server.tool("immich_ping", "Verify Immich connectivity and return server pong.", {}, async () => {
    try {
      const res = await sdk.pingServer();
      return asMcpResponse(res);
    } catch (e) {
      return asMcpError(surfaceError(e));
    }
  });

  server.tool(
    "immich_get_server_info",
    "Return Immich server config (login page, OAuth, theme, etc.).",
    {},
    async () => {
      try {
        const res = await sdk.getServerConfig();
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_get_server_statistics",
    "Photo, video, and user counts plus per-user storage usage.",
    {},
    async () => {
      try {
        const res = await sdk.getServerStatistics();
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_get_capabilities",
    "List enabled Immich features (search, ML, OAuth, etc.).",
    {},
    async () => {
      try {
        const res = await sdk.getServerFeatures();
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_get_storage",
    "Return server storage (used, available, total) and storage template.",
    {},
    async () => {
      try {
        const res = await sdk.getStorage();
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
