export type ProfileColumn = { name: string; type: string };

export interface ProfilingConnection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }>;
}

/** DuckDB identifiers and string literals use different quoting rules. */
export const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

// query_table resolves qualified names while keeping the caller's reference a string literal.
export const tableSource = (name: string): string => `query_table(${literal(name)})`;

/** Normalize floating NaN for metrics that use the extended missingness semantics. */
export function nanAsNull(column: ProfileColumn): string {
  const name = identifier(column.name);
  return /^(FLOAT|DOUBLE|REAL)$/i.test(column.type) ? `CASE WHEN isnan(${name}) THEN NULL ELSE ${name} END` : name;
}

/** Classify DuckDB schema types before any application-supplied role overrides. */
export function kind(type: string): 'numeric' | 'string' | 'boolean' | 'date' | 'unknown' {
  if (
    /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT[1248]?|FLOAT|DOUBLE|REAL|DECIMAL(?:\(\d+,\s*\d+\))?|NUMERIC(?:\(\d+,\s*\d+\))?|BIGNUM)$/i.test(
      type
    )
  )
    return 'numeric';
  if (/^(VARCHAR|CHAR|BPCHAR|TEXT|STRING|UUID|ENUM\(.*\))$/i.test(type)) return 'string';
  if (/^BOOLEAN$/i.test(type)) return 'boolean';
  if (/^(DATE|TIMESTAMP(_S|_MS|_NS|TZ| WITH TIME ZONE)?)$/i.test(type)) return 'date';
  return 'unknown';
}

export function validateProfilingTarget(tableName: string, columns: readonly ProfileColumn[]): void {
  if (typeof tableName !== 'string' || !tableName) throw new Error('tableName must be a non-empty string');
  const names = new Set<string>();
  for (const column of columns) {
    if (typeof column.name !== 'string' || !column.name || typeof column.type !== 'string' || !column.type) {
      throw new Error('Columns require non-empty names and types');
    }
    // DuckDB compares identifier names case-insensitively for ASCII, even when quoted.
    const key = column.name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (names.has(key)) throw new Error(`Duplicate column: ${column.name}`);
    names.add(key);
  }
}
