# Complete Securities Graph Build Notes

## Purpose

Record a future implementation path for building a fuller local Sanctioned Securities graph than the official `securities.csv` company-level export.

This is not part of the immediate implementation. The approved immediate path is to use `securities.csv` as a low-risk company-level data source.

## Key Finding

The securities collection page lists many `Data sources`, but those pages are upstream inputs, not a complete ready-to-join output.

The public `securities` collection metadata currently exposes only:

- `securities.csv`

The securities artifact directory did not expose these common full-graph resources during design research:

- `entities.ftm.json`
- `entities.ftm.json.gz`
- `targets.nested.json`
- `targets.nested.json.gz`
- `entities.json`
- `entities.json.gz`
- `statements.csv`
- `statements.csv.gz`
- `names.txt`

OpenSanctions documentation states that the native complete format is FollowTheMoney JSON, but the securities collection itself does not currently publish that full format as a direct resource.

## Why Not Scrape All Data Source Web Pages

Do not scrape `Data sources` child pages as the build strategy.

Reasons:

- Web pages are presentation surfaces, not stable bulk APIs.
- The child source list mixes normal sources, external enrichers, and helper datasets.
- Some children, such as LEI reference enrichment, may not expose downloadable resources in their OpenSanctions source metadata.
- OpenSanctions performs entity resolution, referent tracking, enrichment, deduplication, and collection-specific export logic after reading the child sources.
- Concatenating child source outputs would create duplicates and would not reliably recreate the official securities collection.

## If Full Graph Is Required

Use a metadata-driven bulk pipeline, not webpage scraping.

### Option A: Use The Default Collection

The `default` collection publishes full FollowTheMoney resources, including:

- `entities.ftm.json`
- `targets.nested.json`
- `statements.csv`
- `senzing.json`

This is the most reliable public path to a full entity graph, but it is very large. Current observed sizes were multi-GB, including roughly:

- `entities.ftm.json`: about 2.66 GB
- `targets.nested.json`: about 4.16 GB
- `statements.csv`: about 9.9 GB

The pipeline must stream and filter. It must never load the full file into memory.

Suggested filter strategy:

1. Read `https://data.opensanctions.org/datasets/latest/default/index.json`.
2. Download the selected full resource to a temporary file with checksum validation.
3. Stream `entities.ftm.json` line by line.
4. Keep entities that satisfy one or more conditions:
   - dataset membership includes `securities`
   - schema is `Security`
   - schema is `Company`, `LegalEntity`, or `Organization` and has securities-related identifiers
   - entity id appears as issuer/owner/entity in a retained relationship
   - schema is `Sanction`, `Ownership`, `Identification`, or link-like schema connected to a retained company/security
5. Because graph edges can point forward and backward, use a two-pass or staged index:
   - pass 1 collects candidate ids and relationship edges
   - pass 2 materializes retained entities
6. Build a compact local SQLite graph table for query use.

### Option B: Child Dataset Bulk Join

This attempts to approximate the securities collection by reading the securities collection's child list:

1. Read `https://data.opensanctions.org/datasets/latest/securities/index.json`.
2. For each `children[]` item, read `https://data.opensanctions.org/datasets/latest/<child>/index.json`.
3. Select machine-readable resources when present:
   - `entities.ftm.json`
   - `targets.nested.json`
   - `senzing.json`
4. Skip or mark unsupported children that have no public resources.
5. Stream every selected resource.
6. Build local canonical ids using:
   - OpenSanctions `id`
   - `referents`
   - strong identifiers such as LEI, PermID, FIGI, ISIN, and source ids
7. Apply conservative merge rules and retain conflict evidence.

This option is not guaranteed to match OpenSanctions' official securities collection because it cannot fully reproduce upstream enrichment and entity resolution.

## Graph Build Output

A future complete-graph SQLite schema should separate company-level query objects from full graph detail:

- `graph_entities`
  - `entity_id`
  - `schema`
  - `caption`
  - `properties_json`
  - `datasets_json`
  - `referents_json`
- `graph_edges`
  - `subject_id`
  - `predicate`
  - `object_id`
  - `source_entity_id`
- `companies`
  - canonical company query row
  - merged status flags
  - compact display fields
- `securities`
  - security entity id
  - issuer company id
  - ISIN, FIGI, ticker, type, currency, maturity, source URL
- `company_identifiers`
  - LEI, PermID, source ids, registration numbers, tax ids
- `name_index`
  - company names, aliases, weak aliases, previous names

The Telegram bot should still query compact company tables. Full graph tables should support `/full` details and future analysis, not drive every query directly.

## Batch Processing Rules

- Always start from metadata JSON, not HTML pages.
- Use resource checksums from metadata.
- Use temp files and publish only after validation.
- Stream JSONL and CSV.
- Do not read production bulk files into memory.
- Do not infer CSV columns by position.
- Record unsupported child datasets and skipped enrichers in build metadata.
- Prefer false non-merges over false merges.
- Preserve OpenSanctions `referents` so future id changes can be reconciled.

## Open Questions For Future Work

- Whether a commercial OpenSanctions data delivery token can expose the securities collection in full FollowTheMoney format.
- Whether the OpenSanctions API can batch-fetch complete entity profiles for the `id` values in `securities.csv`.
- Whether the bot needs all `Security` entities or only company-level securities identifiers.
- Whether multi-GB default collection processing fits the target deployment host.
- Whether a separate offline build machine should prepare SQLite and deploy only the compact database to the bot host.
