CREATE OR REPLACE MACRO _data_profiling_parameters_top_values() AS
    json_object('limit', 3, 'maxDistinctRatio', 0.5);

/* top_values — Non-NULL string/boolean frequencies, ordered by count descending then value ascending.
 * Skip high-cardinality columns; report truncation rather than silently dropping categories.
 */
CREATE OR REPLACE MACRO data_profiling_top_values(column_value) AS CASE
    WHEN _data_profiling_type(first(column_value)) IN ('string', 'boolean')
        AND count(DISTINCT column_value) <= count(*) *
            (_data_profiling_parameters_top_values()->>'maxDistinctRatio')::DOUBLE THEN
        data_profiling_value('object', json_object(
            'entries', data_profiling_value('list', list_transform(
                list_slice(list_sort(list_transform(
                    coalesce(map_entries(histogram(column_value)), []),
                    lambda entry: struct_pack(n := -entry.value::HUGEINT, v := entry.key)
                )), 1, (_data_profiling_parameters_top_values()->>'limit')::INTEGER),
                lambda entry: data_profiling_value('object', json_object(
                    'value', _data_profiling_scalar(entry.v),
                    'count', data_profiling_value('integer', (-entry.n)::VARCHAR)
                ))
            )),
            'truncated', data_profiling_value('boolean', count(DISTINCT column_value) >
                (_data_profiling_parameters_top_values()->>'limit')::INTEGER)
        ))
END;
