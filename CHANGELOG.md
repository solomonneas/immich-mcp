# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-05-18

### Fixed
- `immich_list_trash` now actually returns trashed items. The previous implementation passed `isTrashed: true` to `searchAssets`, which the Immich server silently ignored, so the tool returned non-trash assets from the main timeline. The tool now uses `withDeleted: true` plus an epoch sentinel for `trashedAfter` and post-filters the returned items to `isTrashed === true`.
- `immich_restore_by_query` had the same search-side bug and additionally called `updateAssets({ isTrashed: false })`, which the SDK also silently dropped: nothing was ever restored. The tool now calls the dedicated `restoreAssets({ bulkIdsDto: { ids } })` endpoint, pages through trash until exhausted or `maxRestore` is hit, and requires `confirm: true` when invoked with no filter (would otherwise restore every trashed asset).
- `immich_run_job` now requires `confirm: true` for destructive queue commands (`empty`, `clear-failed`). Other commands (`start`, `pause`, `resume`) are unchanged.
- `immich_suggest_face_names` no longer returns `thumbnailPath` (a server-side file path that is not useful to callers and was not in the spec). Response shape is now `{ personId, faceCount }`; pair with `immich_get_person_assets` to fetch a sample asset per person.
- `immich_search_then_album` now rejects when both `smartQuery` and `metadataFilter` are provided. The previous implementation silently dropped `metadataFilter`.
- `immich_daily_digest` now filters new uploads by `createdAfter` (upload time) instead of `takenAfter` (capture time). New imports of old photos now count correctly.
- `test:integration` script now builds the project before invoking the integration suite (`npm run build && IMMICH_INTEGRATION=true vitest ...`).
- `withRetry` now logs one stderr line per retry attempt for minimal production observability. The `label` parameter is no longer discarded.

## [0.3.0] - 2026-05-18

### Added
- Composed LLM-native tools: `immich_memories_today`, `immich_daily_digest`, `immich_suggest_face_names`, `immich_search_then_album`.
- Trash domain: `immich_list_trash`, `immich_empty_trash` (writes + confirm), `immich_restore_by_query`.
- Jobs domain: `immich_list_jobs`, `immich_run_job`.
- Retry/backoff helper (`src/retry.ts`) on HTTP 429 and 5xx responses.
- Sharper error parsing in `surfaceError` (differentiates 401/403/404/429/5xx).
- GitHub Actions CI: typecheck + test + build on Node 20 and 22.
- Renovate config for weekly dependency bumps.
- Live integration test suite under `tests/integration/`, gated by `IMMICH_INTEGRATION=true`.

## [0.2.0] - 2026-05-18

### Added
- Composed dedup tools: `immich_categorize_duplicates`, `immich_find_byte_dupes`, `immich_resolve_with_keep_strategy`.

## [0.1.0] - 2026-05-17

### Added
- Initial release. 56 MCP tools across 11 domains (system, assets, search, albums, people, tags, shared links, activities, memories, duplicates, stacks). Wraps `@immich/sdk`. Two-tier write protection: `IMMICH_ALLOW_WRITES` env + per-call `confirm: true`. README with five-MCP-client setup.
