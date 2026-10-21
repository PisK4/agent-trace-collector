import { dirname, join } from 'node:path';
import type { Config } from './config';
import { loadLocalSecret } from './config';
import { openStore } from './store';
import type { Store } from './store';
import { readBatch, readRouteFiles } from './sources/files';
import type { FileCursor } from './sources/files';
import { ingestLedger, ingestRoute } from './reconcile';
import { probeMagpie, syncCosts } from './sources/magpie';
import { createHandler, loadReadToken } from './http';
import { reconcilePending } from './hook';
import { drainDerive, pairToolCalls } from './derive';

const LEDGER_INTERVAL_MS = 5000;
const ROUTE_INTERVAL_MS = 2000;
const COST_INTERVAL_MS = 60_000;
const PROBE_INTERVAL_MS = 60_000;
const DERIVE_INTERVAL_MS = 2000;

function readCursor(store: Store, sourceKind: string, sourceName: string): FileCursor | null {
  const row = store.read.query<{
    file_generation: string; committed_off: number; seen_size: number | null;
    head_len: number | null; head_hash: string | null; rewrite_epoch: number;
  }, [string, string]>(
    'SELECT file_generation, committed_off, seen_size, head_len, head_hash, rewrite_epoch FROM source_cursor WHERE source_kind=? AND source_name=?',
  ).get(sourceKind, sourceName);
  if (row == null) return null;
  const match = /^(.*):(\d+)$/.exec(row.file_generation);
  return {
    generation: row.file_generation,
    rewriteEpoch: row.rewrite_epoch,
    committedOff: row.committed_off,
    seenSize: row.seen_size ?? 0,
    headLen: row.head_len ?? 0,
    headHash: row.head_hash,
  };
}

export async function startCollector(config: Config): Promise<{ port: number; stop(): Promise<void> }> {
  const dbPath = join(config.dataDir, 'trace.db');
  const store = openStore(dbPath);
  const salt = loadLocalSecret(config.dataDir, 'redaction.salt');
  const readToken = loadReadToken(config.dataDir);
  const hookToken = Buffer.from(loadLocalSecret(config.dataDir, 'hook.token')).toString('base64url');
  let handler: (req: Request) => Promise<Response> = () => Promise.resolve(new Response('starting', { status: 503 }));

  const timers: ReturnType<typeof setInterval>[] = [];
  let running = false;
  let stopped = false;

  const guard = (name: string, task: () => Promise<void> | void) => async () => {
    if (stopped || running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown';
      process.stderr.write(`${name}_failed:${code}\n`);
    } finally {
      running = false;
    }
  };

  const ledgerTick = guard('ledger', async () => {
    const cursor = readCursor(store, 'ledger', 'usage.jsonl');
    const batch = await readBatch(config.ledgerPath, cursor);
    if (batch.lines.length === 0 && batch.issues.length === 0 && batch.committedOff === (cursor?.committedOff ?? 0)) {
      if (cursor !== null && batch.observedOff !== cursor.committedOff) {
        store.write(db => db.run(
          'UPDATE source_cursor SET observed_off=? WHERE source_kind=? AND source_name=?',
          [batch.observedOff, 'ledger', 'usage.jsonl'],
        ));
      }
      return;
    }
    ingestLedger(store, 'usage.jsonl', batch, Date.now(), salt);
  });

  const routeTick = guard('route', async () => {
    const files = await readRouteFiles(config.routingDir);
    for (const file of files) {
      if (file.error !== null) {
        process.stderr.write(`route_file_error:${file.name}\n`);
        continue;
      }
      const kind = file.kind === 'gz' ? 'route_gz' : 'route_file';
      const cursorRow = store.read.query<{ fingerprint: string | null }, [string, string]>(
        'SELECT fingerprint FROM source_cursor WHERE source_kind=? AND source_name=?',
      ).get(kind, file.name);
      if (cursorRow?.fingerprint === file.fingerprint) continue;
      const now = Date.now();
      const records: unknown[] = [];
      for (const line of file.lines) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          store.write(db => db.run(
            `INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at) VALUES (?,?,?,?)
             ON CONFLICT DO UPDATE SET observed_at=excluded.observed_at`,
            ['route', JSON.stringify([file.name, file.fingerprint]), 'route_invalid_json', now],
          ));
        }
      }
      ingestRoute(store, records, now, salt);
      const committed = file.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
      store.write(db => db.run(
        `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,fingerprint,last_ok_ms)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(source_kind,source_name) DO UPDATE SET
           file_generation=excluded.file_generation,committed_off=excluded.committed_off,
           fingerprint=excluded.fingerprint,last_ok_ms=excluded.last_ok_ms`,
        [kind, file.name, file.fingerprint, committed, file.fingerprint, now],
      ));
    }
  });

  const costTick = guard('cost', async () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await syncCosts(store, `${day}..${day}`, config.magpieUrl, Date.now(), salt);
  });

  const probeTick = guard('probe', async () => {
    const versionFile = join(dirname(config.ledgerPath), 'last-version');
    const result = await probeMagpie(config.magpieUrl, versionFile);
    store.write(db => db.run(
      'INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
      [JSON.stringify(['magpie', 'probe']), JSON.stringify({ ...result, at: Date.now() })],
    ));
  });

  const pendingTick = guard('pending', () => {
    reconcilePending(store, Date.now());
  });

  const deriveTick = guard('derive', () => {
    const result = drainDerive(store);
    // 只重配本批真正处理过的分组，不扫描全库。
    for (const group of result.groups) {
      pairToolCalls(store, group.conv_key, group.actor);
    }
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,
    fetch: (req: Request) => handler(req),
  });
  const boundPort = server.port ?? config.port;
  handler = createHandler(store, { ...config, port: boundPort }, readToken, { token: hookToken, salt });

  timers.push(setInterval(ledgerTick, LEDGER_INTERVAL_MS));
  timers.push(setInterval(routeTick, ROUTE_INTERVAL_MS));
  timers.push(setInterval(costTick, COST_INTERVAL_MS));
  timers.push(setInterval(probeTick, PROBE_INTERVAL_MS));
  timers.push(setInterval(pendingTick, LEDGER_INTERVAL_MS));
  timers.push(setInterval(deriveTick, DERIVE_INTERVAL_MS));
  void ledgerTick();
  void routeTick();
  void probeTick();
  void pendingTick();
  void deriveTick();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    await server.stop(true);
    store.close();
  };

  const onSignal = () => {
    void stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { port: boundPort, stop };
}

if (import.meta.main) {
  const { loadConfig } = await import('./config');
  const config = loadConfig();
  const collector = await startCollector(config);
  process.stdout.write(`collector_listening:${collector.port}\n`);
}
