<p align="center">
  <img src="assets/immich-mcp-banner.jpg" alt="immich-mcp banner" />
</p>

<h1 align="center">immich-mcp</h1>

<p align="center"><em>Speak to your Immich library in tool calls.</em></p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/solomonneas/immich-mcp?label=release&color=2563EB&style=for-the-badge" alt="GitHub release" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5.7" />
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/MCP-1.x-7C3AED?style=for-the-badge" alt="MCP 1.x" />
  <img src="https://img.shields.io/badge/License-MIT-2EA043?style=for-the-badge" alt="MIT License" />
</p>

An MCP (Model Context Protocol) server for [Immich](https://immich.app). Exposes Immich's photo and video library surface to LLMs - browse and search assets, manage albums and tags, recognize and merge people, surface memories, resolve duplicates, and group motion photos into stacks, all as typed tool calls.

Companion to [jellyfin-mcp](https://github.com/solomonneas/jellyfin-mcp) and [reelgrep-mcp](https://github.com/solomonneas/reelgrep-mcp) in the home-media MCP family.

## Features

- **~55 MCP tools** across 11 domains, more comprehensive coverage than existing options
- **Memories**, **duplicates**, and **stacks** support out of the box (net-new versus other Immich MCP servers)
- Smart / CLIP semantic search via `immich_search_smart` plus metadata search and the discovery "explore" feed
- Two-tier write protection: writes are gated by the `IMMICH_ALLOW_WRITES=true` env var, and destructive tools additionally require `confirm: true` per call
- People recognition: list, update, hide, get assets per person, merge duplicates
- Albums, tags, shared links, and activities as first-class typed surfaces
- Asset uploads from local paths, EXIF reads, and original / thumbnail downloads
- Works with Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI, and any MCP-compatible client

## Tools

### System (5)
- `immich_ping` - health check
- `immich_get_server_info` - version, build, features
- `immich_get_server_statistics` - photo count, video count, total usage
- `immich_get_storage` - disk usage and free space
- `immich_get_capabilities` - feature flags exposed by the server

### Assets (11)
- `immich_list_assets` - paginated list with filters
- `immich_get_asset` - full asset metadata
- `immich_get_asset_exif` - EXIF block for one asset
- `immich_get_asset_statistics` - per-library counts
- `immich_update_asset` - rename, set favorite, archive, set description
- `immich_bulk_update_assets` - bulk favorite / archive / visibility *(requires `confirm: true`)*
- `immich_delete_asset` - soft delete (trash) by default; pass `permanent: true` to bypass trash *(permanent delete requires `confirm: true`)*
- `immich_restore_from_trash` - undo a soft delete
- `immich_download_asset_original` - return the original file bytes
- `immich_download_asset_thumbnail` - return a preview/thumbnail
- `immich_upload_asset_from_path` - upload a local file

### Search (3)
- `immich_search_smart` - CLIP / semantic search by natural-language query
- `immich_search_metadata` - structured search (date range, camera make, location, etc.)
- `immich_search_explore` - server-side discovery feed (cities, people, things)

### Albums (8)
- `immich_list_albums`
- `immich_get_album`
- `immich_get_album_statistics`
- `immich_create_album`
- `immich_update_album`
- `immich_add_assets_to_album`
- `immich_remove_assets_from_album`
- `immich_delete_album` *(requires `confirm: true`)*

### People (6)
- `immich_list_people`
- `immich_get_person`
- `immich_get_person_assets` - photos and videos this face appears in
- `immich_update_person` - rename, set birth date, set thumbnail
- `immich_hide_person` - exclude from discovery without deleting
- `immich_merge_people` - fold duplicate face clusters into one *(requires `confirm: true`)*

### Tags (7)
- `immich_list_tags`
- `immich_get_tag`
- `immich_create_tag`
- `immich_update_tag`
- `immich_delete_tag` *(requires `confirm: true`)*
- `immich_add_tag_to_assets`
- `immich_remove_tag_from_assets`

### Shared Links (5)
- `immich_list_shared_links`
- `immich_get_shared_link`
- `immich_create_shared_link`
- `immich_update_shared_link`
- `immich_delete_shared_link` *(requires `confirm: true`)*

### Activities (4)
- `immich_list_activities` - comments and likes on shared albums
- `immich_get_activity_statistics`
- `immich_create_activity`
- `immich_delete_activity` *(requires `confirm: true`)*

### Memories (2)
- `immich_list_memories` - "on this day" and other generated memories
- `immich_get_memory`

### Duplicates (2)
- `immich_list_duplicates` - duplicate clusters detected by Immich's hashing pass
- `immich_resolve_duplicates` - pick a keeper, trash the others *(requires `confirm: true`)*

### Stacks (4)
- `immich_list_stacks` - stack groups (motion photos, bracketed shots, RAW + JPEG pairs)
- `immich_create_stack`
- `immich_update_stack` - re-pick the primary asset or add/remove members
- `immich_delete_stack` *(requires `confirm: true`)*

## Install

```bash
npm install -g immich-mcp
```

Or from source:

```bash
git clone https://github.com/solomonneas/immich-mcp.git
cd immich-mcp
npm install
npm run build
```

## Configuration

Set these environment variables in your MCP client config:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IMMICH_BASE_URL` | yes | - | Base URL of your Immich API, e.g. `https://photos.example.com/api` |
| `IMMICH_API_KEY` | yes | - | API key from Account Settings > API Keys in the Immich web UI |
| `IMMICH_ALLOW_WRITES` | no | `false` | Set to `true` to expose write and delete tools. Reads always work. |
| `IMMICH_VERIFY_SSL` | no | `true` | Set to `false` for self-signed certs |

### Getting an API key

1. Log into Immich
2. Account Settings > API Keys > New API Key
3. Name it (e.g. `mcp`) and copy the value

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "immich-mcp": {
      "command": "immich-mcp",
      "env": {
        "IMMICH_BASE_URL": "https://photos.example.com/api",
        "IMMICH_API_KEY": "YOUR_KEY",
        "IMMICH_ALLOW_WRITES": "false"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add immich-mcp \
  -e IMMICH_BASE_URL=https://photos.example.com/api \
  -e IMMICH_API_KEY=YOUR_KEY \
  -e IMMICH_ALLOW_WRITES=false \
  -- immich-mcp
```

Add `--scope user` to make it available from any directory instead of only the current project.

### OpenClaw

Add to `~/.openclaw/openclaw.json` under `mcps.entries.immich-mcp`:

```json
{
  "mcps": {
    "entries": {
      "immich-mcp": {
        "command": "immich-mcp",
        "env": {
          "IMMICH_BASE_URL": "https://photos.example.com/api",
          "IMMICH_API_KEY": "YOUR_KEY",
          "IMMICH_ALLOW_WRITES": "false"
        }
      }
    }
  }
}
```

Or, when running from a source checkout instead of the global npm install:

```json
{
  "mcps": {
    "entries": {
      "immich-mcp": {
        "command": "node",
        "args": ["/absolute/path/to/immich-mcp/dist/index.js"],
        "env": {
          "IMMICH_BASE_URL": "https://photos.example.com/api",
          "IMMICH_API_KEY": "YOUR_KEY",
          "IMMICH_ALLOW_WRITES": "false"
        }
      }
    }
  }
}
```

Then restart the OpenClaw gateway so the new server is picked up:

```bash
systemctl --user restart openclaw-gateway
openclaw mcp list   # confirm "immich-mcp" is registered
```

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads MCP config from `~/.hermes/mcps.json`. Add an entry:

```json
{
  "mcpServers": {
    "immich-mcp": {
      "command": "immich-mcp",
      "env": {
        "IMMICH_BASE_URL": "https://photos.example.com/api",
        "IMMICH_API_KEY": "YOUR_KEY",
        "IMMICH_ALLOW_WRITES": "false"
      }
    }
  }
}
```

Or, when running from a source checkout:

```json
{
  "mcpServers": {
    "immich-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/immich-mcp/dist/index.js"],
      "env": {
        "IMMICH_BASE_URL": "https://photos.example.com/api",
        "IMMICH_API_KEY": "YOUR_KEY",
        "IMMICH_ALLOW_WRITES": "false"
      }
    }
  }
}
```

Then reload MCP from inside a Hermes session:

```
/reload-mcp
```

### Codex CLI

[Codex CLI](https://github.com/openai/codex) reads MCP servers from `~/.codex/config.toml`. Add a `[mcp_servers.immich-mcp]` block:

```toml
[mcp_servers.immich-mcp]
command = "immich-mcp"
env = { IMMICH_BASE_URL = "https://photos.example.com/api", IMMICH_API_KEY = "YOUR_KEY", IMMICH_ALLOW_WRITES = "false" }
```

Or, when running from a source checkout:

```toml
[mcp_servers.immich-mcp]
command = "node"
args = ["/absolute/path/to/immich-mcp/dist/index.js"]
env = { IMMICH_BASE_URL = "https://photos.example.com/api", IMMICH_API_KEY = "YOUR_KEY", IMMICH_ALLOW_WRITES = "false" }
```

Verify with:

```bash
codex mcp list
```

## Example Prompts

> Show me memories from this week.

Calls `immich_list_memories` and filters by the current week.

> Find duplicate photos and tell me which to delete (don't delete yet).

Calls `immich_list_duplicates` and returns the clusters as a dry run, without calling `immich_resolve_duplicates`.

> Group these motion photos into a stack.

Calls `immich_create_stack` with the asset IDs and a primary pick.

## License

MIT - see [LICENSE](LICENSE).
