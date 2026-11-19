/*
 * row_count — Total rows, including duplicates and rows containing NULL.
 * Returns zero for an empty input.
 */
CREATE OR REPLACE MACRO data_profiling_row_count() AS count(*);

/*
 * column_count — Columns exposed by the input table or view, including on empty inputs.
 * Read column metadata rather than scanning column values.
 */
CREATE OR REPLACE MACRO data_profiling_column_count(table_name) AS (
    SELECT count(*) FROM pragma_table_info(table_name)
);
