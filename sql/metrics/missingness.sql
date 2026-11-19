/*
 * missing_count — SQL NULL values in a column; empty inputs return zero.
 * Empty strings, zero and NaN are not treated as NULL.
 */
CREATE OR REPLACE MACRO data_profiling_missing_count(column_value) AS
    count(*) - count(column_value);
