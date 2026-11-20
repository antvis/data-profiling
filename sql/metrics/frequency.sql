CREATE OR REPLACE MACRO _data_profiling_parameters_top_values(options_json := '{}'::JSON) AS CASE
    WHEN coalesce(json_type(options_json) <> 'OBJECT', true)
        OR len(list_filter(json_keys(options_json), lambda k: k NOT IN ('limit', 'maxDistinctRatio'))) > 0
        THEN error('top_values parameters must be an object containing only limit and maxDistinctRatio')
    WHEN (json_extract(options_json, 'limit')) IS NOT NULL AND NOT coalesce(
        isfinite(TRY_CAST(json_extract_string(options_json, 'limit') AS DOUBLE))
        AND TRY_CAST(json_extract_string(options_json, 'limit') AS DOUBLE) BETWEEN 0 AND 9007199254740991
        AND TRY_CAST(json_extract_string(options_json, 'limit') AS DOUBLE) = floor(TRY_CAST(json_extract_string(options_json, 'limit') AS DOUBLE))
        AND json_type(json_extract(options_json, 'limit')) IN ('BIGINT', 'UBIGINT', 'DOUBLE'), false)
        THEN error('top_values.limit must be a non-negative safe integer')
    WHEN (json_extract(options_json, 'maxDistinctRatio')) IS NOT NULL AND NOT coalesce(
        TRY_CAST(json_extract_string(options_json, 'maxDistinctRatio') AS DOUBLE) BETWEEN 0 AND 1
        AND json_type(json_extract(options_json, 'maxDistinctRatio')) IN ('BIGINT', 'UBIGINT', 'DOUBLE'), false)
        THEN error('top_values.maxDistinctRatio must be between 0 and 1')
    ELSE json_object(
        'limit', coalesce(TRY_CAST(json_extract_string(options_json, 'limit') AS BIGINT), 3),
        'maxDistinctRatio', coalesce(TRY_CAST(json_extract_string(options_json, 'maxDistinctRatio') AS DOUBLE), 0.5)
    )
END;

/* top_values — Non-NULL string/boolean frequencies, ordered by count descending then value ascending.
 * Skip high-cardinality columns; report truncation rather than silently dropping categories.
 */
CREATE OR REPLACE MACRO data_profiling_top_values(column_value, metric_parameters := '{}'::JSON) AS CASE
    WHEN _data_profiling_type(first(column_value)) IN ('string', 'boolean')
        AND count(DISTINCT column_value) <= count(*) *
            (_data_profiling_parameters_top_values(metric_parameters)->>'maxDistinctRatio')::DOUBLE THEN
        data_profiling_value('object', json_object(
            'entries', data_profiling_value('list', list_transform(
                list_slice(list_sort(list_transform(
                    coalesce(map_entries(histogram(column_value)), []),
                    lambda entry: struct_pack(n := -entry.value::HUGEINT, v := entry.key)
                )), 1, (_data_profiling_parameters_top_values(metric_parameters)->>'limit')::BIGINT),
                lambda entry: data_profiling_value('object', json_object(
                    'value', _data_profiling_scalar(entry.v),
                    'count', data_profiling_value('integer', (-entry.n)::VARCHAR)
                ))
            )),
            'truncated', data_profiling_value('boolean', count(DISTINCT column_value) >
                (_data_profiling_parameters_top_values(metric_parameters)->>'limit')::BIGINT)
        ))
END;
