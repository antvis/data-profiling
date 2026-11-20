/* min_length/max_length — Unicode character counts, including empty strings and trailing spaces. */
CREATE OR REPLACE MACRO data_profiling_min_length(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) = 'string' THEN
        _data_profiling_scalar(min(length(column_value::VARCHAR)))
END;

CREATE OR REPLACE MACRO data_profiling_max_length(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) = 'string' THEN
        _data_profiling_scalar(max(length(column_value::VARCHAR)))
END;
