CREATE OR REPLACE MACRO data_profiling(table_name) AS TABLE
SELECT unnest(data_profiling_result(
    table_name,
    CASE WHEN column_name IS NULL THEN []::VARCHAR[] ELSE [column_name] END,
    metric,
    value
))
FROM (
    SELECT
        unnest([NULL::VARCHAR, NULL::VARCHAR, *COLUMNS('^name_')]) AS column_name,
        unnest(['row_count', 'column_count'] ||
            list_transform([*COLUMNS('^name_')], lambda name: 'missing_count')) AS metric,
        unnest([row_count, data_profiling_column_count(table_name), *COLUMNS('^missing_')]) AS value
    FROM (
        SELECT *, substr(alias(COLUMNS('^missing_')), length('missing_') + 1) AS "name_\0"
        FROM (
            SELECT
                data_profiling_row_count() AS row_count,
                data_profiling_missing_count(COLUMNS(*)) AS "missing_\0"
            FROM query_table(table_name)
        )
    )
);
