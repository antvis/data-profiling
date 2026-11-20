/* Typed JSON values keep exact integers and decimals separate from floating-point numbers. */
CREATE OR REPLACE MACRO data_profiling_value(value_type, payload) AS
    json_object('type', value_type, 'value', payload);

/* Internal helpers are outside the metric prefix so discovery only finds public metrics. */
CREATE OR REPLACE MACRO _data_profiling_type(column_value) AS CASE
    WHEN regexp_full_match(typeof(column_value),
        'U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL\(.*\)|BIGNUM') THEN 'numeric'
    WHEN regexp_full_match(typeof(column_value), 'VARCHAR|UUID|ENUM\(.*\)') THEN 'string'
    WHEN typeof(column_value) = 'BOOLEAN' THEN 'boolean'
    WHEN regexp_full_match(typeof(column_value), 'DATE|TIMESTAMP(_S|_MS|_NS| WITH TIME ZONE)?') THEN 'date'
    ELSE 'unknown'
END;

CREATE OR REPLACE MACRO _data_profiling_finite(column_value) AS CASE
    WHEN _data_profiling_type(column_value) = 'date' THEN column_value::VARCHAR NOT IN ('infinity', '-infinity')
    WHEN typeof(column_value) IN ('FLOAT', 'DOUBLE') THEN isfinite(TRY_CAST(column_value AS DOUBLE))
    ELSE true
END;

CREATE OR REPLACE MACRO _data_profiling_scalar(column_value) AS CASE
    WHEN column_value IS NULL THEN data_profiling_value('null', NULL)
    WHEN typeof(column_value) IN ('FLOAT', 'DOUBLE') THEN CASE
        WHEN isfinite(TRY_CAST(column_value AS DOUBLE)) THEN data_profiling_value('number', TRY_CAST(column_value AS DOUBLE))
        ELSE data_profiling_value('number', column_value::VARCHAR)
    END
    WHEN starts_with(typeof(column_value), 'DECIMAL(') THEN data_profiling_value('decimal', column_value::VARCHAR)
    WHEN _data_profiling_type(column_value) = 'numeric' THEN data_profiling_value('integer', column_value::VARCHAR)
    WHEN typeof(column_value) = 'BOOLEAN' THEN data_profiling_value('boolean', TRY_CAST(column_value AS BOOLEAN))
    WHEN typeof(column_value) = 'DATE' THEN data_profiling_value('date', column_value::VARCHAR)
    WHEN typeof(column_value) = 'TIMESTAMP WITH TIME ZONE' THEN data_profiling_value('timestamptz',
        strftime(TRY_CAST(column_value AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ'))
    WHEN _data_profiling_type(column_value) = 'date' THEN
        data_profiling_value('timestamp', replace(column_value::VARCHAR, ' ', 'T'))
    ELSE data_profiling_value('string', column_value::VARCHAR)
END;

/* All metric categories share this versioned result envelope. */
CREATE OR REPLACE MACRO data_profiling_result(source_table, target_columns, metric_id, metric_value,
    metric_parameters := '{}'::JSON) AS struct_pack(
    protocol_version := 1,
    table_name := source_table::VARCHAR,
    columns := target_columns::VARCHAR[],
    metric := metric_id::VARCHAR,
    parameters := metric_parameters::JSON,
    value := metric_value::JSON
);
