# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-05-18

### Fixed
- `buildAssetAlbumIndex` now fails fast on errors instead of silently returning an empty map. With `albumAware: true` (the default), a 403/500/SDK shape change in the albums endpoint used to silently downgrade the keeper decision to strategy-only, which could trash curated assets. Errors now propagate to the tool handler and surface as a clear MCP error.
- `exportTo` in `immich_resolve_with_keep_strategy` is now gated by `IMMICH_ALLOW_WRITES` (it is a filesystem write). Previously a caller with writes disabled could still cause the CSV to be written. The CSV writer also now (1) verifies the parent directory exists and surfaces a clear error otherwise, and (2) uses the `wx` flag so it refuses to overwrite an existing file.
- CSV cells whose values begin with `=`, `+`, `-`, `@`, `\t`, or `\r` are now prefixed with a single quote to neutralize spreadsheet formula injection (CWE-1236) before the cell is RFC-4180 quoted.
- `immich_explain_duplicate_group` recommendation is now deterministic across runs (final tiebreaker on asset id) and the `rationale` only mentions signals that actually contributed to the winner over the runner-up. The previous version always appended "oldest" even when the pick was driven by album membership or favorite status.
- `webBaseUrl` inputs are now schema-validated to `http://` or `https://` only (previously `z.string().url()` accepted `javascript:`, `ftp:`, etc.), and asset ids are URL-encoded into the path to handle ids with spaces or reserved characters.
- `tailSample` now actually samples the long tail: the 10 buckets with the lowest reclaimable bytes (tiebroken on `duplicateId`), instead of the lex-first 10 by `duplicateId`.

### Changed (behavior change)
- `EnrichedBucket` shape for flagged buckets: `keeper` is now `null` and `discards` is `[]` instead of an arbitrary placeholder. A new optional `members: EnrichedAssetRef[]` array contains every asset in the flagged bucket so callers can still display the data. Flagged buckets also report `reclaimableBytes: 0` (nothing was selected). The CSV writer emits empty cells for `keeperId`/`keeperFileCreatedAt`/`keeperAlbums`/`discardIds`/`discardAlbums` on flagged rows.
- `immich_categorize_duplicates` output keys are now hyphenated (`byte-exact`, `resolution-variants`, `burst-sequence`) instead of snake_case (`byte_exact`, `resolution_variants`, `burst_sequence`). This unifies the category vocabulary with the bucket-level `matchReason` field that was already hyphenated. v0.2.0 shipped snake_case and v0.4.0 introduced the inconsistency by hyphenating `matchReason`; v0.4.1 fixes it before it becomes entrenched. Backward-incompatible for callers that consume `byCategory.*` by name.

## [0.4.0] - 2026-05-18

### Added
- `immich_explain_duplicate_group` tool for per-group drill-in (assets + album memberships + recommended keeper).
- Album-aware keeper selection in `immich_find_byte_dupes` and `immich_resolve_with_keep_strategy` (input: `albumAware`, default `true`). Buckets with split curation are flagged for manual review instead of swept.
- Enriched per-bucket detail in dry-run output: `topByReclaim`, `tailSample`, `flagged` arrays with keeper + discards + album memberships + optional web URLs.
- `matchReason` field on every dedup bucket.
- `restoreNote` field on every resolve response (clarifies undo path).
- CSV export for resolve plans via `exportTo` input.

### Changed
- `immich_find_byte_dupes` output shape extends to include `topByReclaim`, `tailSample`, `flagged`. Existing `candidates` array preserved for back-compat.
- `immich_resolve_with_keep_strategy` dry-run output shape extends similarly. Existing `plan` aggregate preserved.

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
