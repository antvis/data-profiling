---
name: data-profiling
description: Generate a reproducible descriptive profile and an offline HTML report for a local CSV, JSON, or Parquet dataset. Use for data profiling, schema inspection, completeness and cardinality assessment, or an initial review of data suitability before analysis.
---

# Data Profiling

Use this skill to establish the structure, completeness, and empirical characteristics of a tabular dataset. Treat the profile as descriptive evidence about the supplied data and its coverage.

## Define the scope

- Resolve the input to a local file. The runner accepts headered CSV, tabular JSON, and Parquet. Preserve the source and apply any requested field selection explicitly.
- Identify the unit of observation and the key fields when the user has supplied that context. Where field semantics are uncertain, use neutral descriptions grounded in the documented or inferred schema.
- Limit metric selection to the analytical question when possible. Use the [metric catalog](references/metrics.md) to identify default and optional IDs, eligible field types, and denominators.

## Execute the profile

Use Node.js 22.13 or later and npm. Set `SKILL_DIR` to the absolute path of this skill directory. Initialize dependencies once using the lockfile. The initial installation requires network access.

```sh
npm ci --prefix "$SKILL_DIR"
```

Set `INPUT_FILE` to the local source file and `OUTPUT_PARENT` to an existing output parent directory. Invoke [the runner](scripts/profile.mjs).

```sh
node "$SKILL_DIR/scripts/profile.mjs" "$INPUT_FILE" --out-dir "$OUTPUT_PARENT"
```

The runner computes the profile locally using DuckDB SQL and writes `profile.json` and `report.html` to a newly allocated output directory. Read the two paths from its JSON response. Use repeatable `--column` options to select fields and repeatable `--metric` options to replace the default selection with supported native metric IDs. The row count always describes the full input. Table-wide missingness metrics use the selected fields. Set `--language zh-CN` or `--language en-US` as appropriate for the report.

On execution failure, inspect the reported prerequisite, input, or computation error. Base the response on successfully computed artifacts.

## Interpret and deliver

- State the input scope, row count, and relevant field types. CSV and JSON types are inferred. Verify the source definitions when interpretation depends on an identifier, date, or coded field.
- Report the most consequential observations with their field, statistic, count, and denominator where available. The missingness calculation includes SQL NULL and floating-point NaN. The JSON preserves exact integer and decimal values as annotated strings.
- Distinguish a computed null from an unavailable metric. Consult `skipped` for type and cardinality diagnostics. An observed distinct count or concentration is descriptive evidence. Assertions about key validity and business exceptions require the applicable domain rules.
- Link the generated HTML report and, when the structured results are useful to the user, the JSON profile. Verify the files before claiming delivery.
