import { writeSync } from 'node:fs';
import { openStore } from '../src/store';

const [dbPath, mode] = Bun.argv.slice(2);
if (!dbPath || (mode !== 'before-commit' && mode !== 'after-commit')) {
  console.error('usage: worker.ts <db-path> before-commit|after-commit');
  process.exit(2);
}

const store = openStore(dbPath);
const insertLedger = store.db.prepare(
  "INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json,route_id) VALUES ('file','g:0',?,'2026-10-20T00:00:00Z',1,'through','{}',7)",
);
const insertCursor = store.db.prepare(
  "INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms) VALUES ('ledger','usage.jsonl','g:0',100,1)",
);

function waitForKill(): void {
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (mode === 'before-commit') {
  store.write(db => {
    insertLedger.run(0);
    insertLedger.run(1);
    insertCursor.run();
    waitForKill();
  });
} else {
  store.write(db => {
    insertLedger.run(0);
    insertLedger.run(1);
    insertCursor.run();
  });
  waitForKill();
}
