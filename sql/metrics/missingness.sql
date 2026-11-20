/*
 * missing_count — SQL NULL values in a column; empty inputs return zero.
 * Empty strings, zero and NaN are not treated as NULL.
 */
CREATE OR REPLACE MACRO data_profiling_missing_count(column_value) AS
    data_profiling_value('integer', (count(*) - count(column_value))::VARCHAR);

/* null_count — AVA's name for the same SQL NULL count. */
CREATE OR REPLACE MACRO data_profiling_null_count(column_value) AS
    data_profiling_missing_count(column_value);
