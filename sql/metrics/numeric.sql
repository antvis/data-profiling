/* min/max — Numeric or temporal bounds; exclude non-finite values and retain native precision. */
CREATE OR REPLACE MACRO data_profiling_min(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) IN ('numeric', 'date') THEN
        _data_profiling_scalar(min(column_value) FILTER (WHERE _data_profiling_finite(column_value)))
END;

CREATE OR REPLACE MACRO data_profiling_max(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) IN ('numeric', 'date') THEN
        _data_profiling_scalar(max(column_value) FILTER (WHERE _data_profiling_finite(column_value)))
END;

/* mean — Arithmetic mean of finite numeric values, using DuckDB's DOUBLE result. */
CREATE OR REPLACE MACRO data_profiling_mean(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) = 'numeric' THEN
        _data_profiling_scalar(avg(TRY_CAST(column_value AS DOUBLE)) FILTER (WHERE _data_profiling_finite(column_value)))
END;
