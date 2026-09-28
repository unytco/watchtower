type SqlValue = string | number | null;
type Columns = Record<string, SqlValue>;

export interface UpsertRow {
  /** Must match the table's primary key or a unique index. */
  key: Record<string, string | number>;
  insertOnly?: Columns;
  /** Compared with the stored row; any difference is a change. */
  content: Columns;
  /** Raised with MAX, never lowered; only a rise is a change. */
  latched?: Record<string, number>;
  /** Written along with a change, never compared. */
  stamp?: Columns;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * D1 bills every row an UPDATE touches, even with identical values, so the
 * row is updated only when a content column differs or a latched column rises.
 */
export function upsertIfChanged(
  db: D1Database,
  table: string,
  { key, insertOnly = {}, content, latched = {}, stamp = {} }: UpsertRow,
): D1PreparedStatement {
  const groups: Columns[] = [key, insertOnly, content, latched, stamp];
  const columns = groups.flatMap((g) => Object.keys(g));
  const changed = [
    ...Object.keys(content).map((c) => `${table}.${c} IS NOT excluded.${c}`),
    ...Object.keys(latched).map((c) => `excluded.${c} > ${table}.${c}`),
  ];
  if (![table, ...columns].every((name) => IDENTIFIER.test(name))) {
    throw new Error(`${table}: table and column names must be plain identifiers`);
  }
  if (new Set(columns).size !== columns.length) {
    throw new Error(`${table}: a column is in two groups`);
  }
  if (changed.length === 0) {
    throw new Error(`${table}: no content or latched column to compare`);
  }
  const set = [
    ...Object.keys(content).map((c) => `${c} = excluded.${c}`),
    ...Object.keys(latched).map((c) => `${c} = MAX(${c}, excluded.${c})`),
    ...Object.keys(stamp).map((c) => `${c} = excluded.${c}`),
  ];
  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT (${Object.keys(key).join(", ")}) DO UPDATE SET ${set.join(", ")}
       WHERE ${changed.join(" OR ")}`,
    )
    .bind(...groups.flatMap((g) => Object.values(g)));
}

export function hourlyBucket(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
