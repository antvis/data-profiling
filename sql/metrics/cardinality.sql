/* distinct_count — Exact non-NULL cardinality for AVA's supported scalar types. */
CREATE OR REPLACE MACRO data_profiling_distinct_count(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) <> 'unknown' THEN
        data_profiling_value('integer', count(DISTINCT column_value)::VARCHAR)
END;
