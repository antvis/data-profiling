/*
 * missing_count — SQL NULL values in a column; empty inputs return zero.
 * Empty strings, zero and NaN are not treated as NULL.
 */
CREATE OR REPLACE MACRO data_profiling_missing_count(column_value) AS
    data_profiling_value('integer', (count(*) - count(column_value))::VARCHAR);

/*
 * present_count — Non-NULL values in a column; empty inputs return zero.
 * Empty strings, zero and NaN are present.
 */
CREATE OR REPLACE MACRO data_profiling_present_count(column_value) AS
    data_profiling_value('integer', count(column_value)::VARCHAR);
