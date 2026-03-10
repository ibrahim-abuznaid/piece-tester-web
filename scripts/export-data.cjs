const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'piece-tester.db'));

const tables = ['piece_connections', 'test_plans', 'schedules', 'piece_lessons'];
const lines = ['-- Exported data from local Piece Tester DB', ''];

for (const table of tables) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) continue;

  lines.push(`-- ${table} (${rows.length} rows)`);
  lines.push(`DELETE FROM ${table};`);

  for (const row of rows) {
    const cols = Object.keys(row);
    const vals = cols.map(c => {
      const v = row[c];
      if (v === null) return 'NULL';
      if (typeof v === 'number') return v;
      return `'${String(v).replace(/'/g, "''")}'`;
    });
    lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
  }
  lines.push('');
}

const outPath = path.join(__dirname, '..', 'migration-data.sql');
fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
console.log(`Exported to migration-data.sql (${lines.length} lines)`);
db.close();
