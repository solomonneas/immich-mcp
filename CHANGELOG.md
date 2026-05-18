# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
