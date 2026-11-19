const { readFileSync } = require('node:fs');
const { join } = require('node:path');

exports.dataProfilingSQL = ['sql/metrics/table.sql', 'sql/metrics/missingness.sql', 'sql/data_profiling.sql']
  .map((file) => readFileSync(join(__dirname, file), 'utf8'))
  .join('\n');
