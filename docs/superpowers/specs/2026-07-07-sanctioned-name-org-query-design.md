# Sanctioned NAME_ORG Query Fix Design

## Problem

Sanctioned securities records can exist in the local OpenSanctions data but remain unqueryable when their names are stored under `NAMES[].NAME_ORG` instead of `NAMES[].NAME_FULL`.

Observed example:

- Query target: `Dongguan Lvzhou Shoes Co. Ltd.` / `Dongguan Oasis Shoes Co. Ltd.`
- Record id: `NK-Vq8tbLjL9hai2V7Jx8PYe4`
- Source file: `securities.senzing.json`
- Current record names:
  - `NAME_ORG: Dongguan Oasis Shoes Co. Ltd.`
  - `NAME_ORG: Dongguan Luzhou Shoes Co. Ltd.`
  - `NAME_ORG: Dongguan Lvzhou Shoes Co. Ltd.`
  - `NAME_ORG: Dongguan Oasis Shoe Industry Co. Ltd.`

The record is present in `securities.sqlite`, but it has no rows in the `names` table because the current indexing code only reads `NAME_FULL`. As a result, exact lookup and fuzzy candidate search cannot find it.

The Chinese query `东莞绿洲鞋业有限公司` is not present in the current local OpenSanctions securities data. This fix will not add translation or external alias enrichment; that query will only match if the source data contains that Chinese name in a supported name field.

## Goals

- Index sanctioned records whose Senzing name entries use `NAME_ORG`.
- Keep SQLite and in-memory repository behavior consistent.
- Show primary names and aliases correctly for records whose display names come from `NAME_ORG`.
- Preserve existing `NAME_FULL` behavior.
- Keep the change small and covered by targeted regression tests.

## Non-Goals

- No machine translation.
- No custom Chinese alias table.
- No change to OpenSanctions catalog discovery.
- No schema migration unless required by implementation. The existing `names.name_full` column can continue to store the selected display name string even when it came from `NAME_ORG`.

## Design

Add a shared Senzing name extraction helper in the domain layer. The helper should accept a `SenzingName` and return the canonical searchable/display string for that name entry.

Extraction order:

1. Use trimmed `NAME_FULL` when present.
2. Otherwise use trimmed `NAME_ORG` when present.
3. Otherwise ignore the entry.

The helper should also support record-level iteration so callers can deduplicate normalized names per record without duplicating extraction rules.

Update all name consumers to use the helper:

- `sqliteBuilder.ts`: insert extracted names into `names` and `name_fts`.
- `senzingMemoryRepository.ts`: build exact and fuzzy indexes from extracted names.
- `entityLookup.ts`: derive `primaryName` and `aliases` from extracted names.
- `securitiesService.ts`: record-id lookup fallback should use the shared primary-name helper or equivalent extracted-name logic.

## Data Flow

Refresh or bootstrap still writes records into `records.record_json` unchanged.

During SQLite build:

1. Read each Senzing record.
2. Store the raw record JSON as today.
3. Iterate `record.NAMES`.
4. Extract `NAME_FULL || NAME_ORG`.
5. Normalize and deduplicate per record.
6. Insert into `names` and `name_fts`.

At query time:

- Exact lookup continues to search `names.normalized_name`.
- Fuzzy lookup continues to search `name_fts`.
- Result formatting reads the raw record but uses the same extraction logic to show primary name and aliases.

## Error Handling

Malformed records should keep current behavior:

- Missing `RECORD_ID` remains a build/load error.
- Name entries without supported name fields are skipped.
- Empty or whitespace-only names are skipped.

No new runtime error state is needed.

## Testing

Add targeted regression coverage:

- SQLite builder indexes a record with only `NAME_ORG`.
- SQLite lookup can find a `NAME_ORG` primary name exactly.
- SQLite fuzzy candidate search can find a `NAME_ORG` alias.
- Memory repository can find `NAME_ORG` names exactly and fuzzily.
- Basic result formatting shows `NAME_ORG` primary and aliases.
- Existing `NAME_FULL` tests continue to pass.

Use the Dongguan/Oasis/Lvzhou shape as the fixture pattern:

- Primary: `Dongguan Oasis Shoes Co. Ltd.`
- Alias: `Dongguan Lvzhou Shoes Co. Ltd.`

## Deployment Note

After code changes land, existing SQLite files must be rebuilt or refreshed. The old `securities.sqlite` already contains the raw record JSON, but the missing `names` and `name_fts` rows will not appear until the database is rebuilt from `securities.senzing.json` or refreshed through `/update`.

## Acceptance Criteria

- `Dongguan Lvzhou Shoes Co. Ltd.` is returned by sanctioned securities lookup after rebuilding the SQLite data.
- `Dongguan Oasis Shoes Co. Ltd.` is returned by sanctioned securities lookup after rebuilding the SQLite data.
- Fuzzy search for `Dongguan Lvzhou` returns the same record as a candidate.
- Existing debarment lookups still pass.
- `东莞绿洲鞋业有限公司` remains outside this fix unless source data includes that exact Chinese name.
