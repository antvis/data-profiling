/* Typed JSON values keep exact integers and decimals separate from floating-point numbers. */
CREATE OR REPLACE MACRO data_profiling_value(value_type, payload) AS
    json_object('type', value_type, 'value', payload);

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
