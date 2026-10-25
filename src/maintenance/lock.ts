/** 维护锁：数据目录下的一个普通文件，服务启动检查与离线命令共用。 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAINTENANCE_LOCK = 'maintenance.lock';

export function lockPath(dataDir: string): string {
  return join(dataDir, MAINTENANCE_LOCK);
}

/** 服务启动时的检查：维护锁在盘上就拒绝启动，不猜它是不是陈旧锁。 */
export function maintenanceLockPresent(dataDir: string): string | null {
  const path = lockPath(dataDir);
  return existsSync(path) ? path : null;
}

export type LockHandle = { recovered: boolean; release(): void };

type LockOptions = {
  /** 判断锁里记录的进程是否还在；测试注入，生产用 kill(pid, 0)。 */
  pidAlive?: (pid: number) => boolean;
};

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): { pid?: unknown; holder?: unknown; started_ms?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 取维护锁，失败返回 null。
 *
 * 维护锁是数据目录下的一个普通文件，用 `wx` 原子创建；内容记 pid 与持有者标识。
 * 陈旧锁不自动覆盖：只有确认原进程已不在、并且调用方明确允许时才清理。
 *
 * 锁存在时先看持有者：同一持有者（本进程重入）视为已持有；不同持有者只有在
 * 记录里的 pid 已不存在、且调用方允许时才会被清掉，否则一律拒绝。
 */
export function acquireMaintenanceLock(
  dataDir: string,
  holder: string,
  options: LockOptions = {},
): LockHandle | null {
  const path = lockPath(dataDir);
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  let recovered = false;
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, holder, started_ms: Date.now() }));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readLock(path);
    if (existing === null) return null;
    if (existing.holder === holder) {
      // 同一持有者重入：沿用这把锁，交由调用方在 finally 里释放。
    } else if (typeof existing.pid === 'number' && !pidAlive(existing.pid)) {
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
      recovered = true;
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, holder, started_ms: Date.now() }));
      closeSync(fd);
    } else {
      return null;
    }
  }
  let released = false;
  return {
    recovered,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // 已经被删掉就算了。
      }
    },
  };
}
