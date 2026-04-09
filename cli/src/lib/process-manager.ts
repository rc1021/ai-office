import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * 讀取 PID 檔案，回傳 PID 數字，若不存在或無效則回傳 null
 */
export function readPid(pidFile: string): number | null {
  try {
    const content = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * 寫入 PID 至指定檔案
 */
export function writePid(pidFile: string, pid: number): void {
  fs.writeFileSync(pidFile, String(pid), 'utf-8');
}

/**
 * 確認 PID 對應的程序是否存活
 * 處理 EPERM（沒有權限）視為程序存在
 * ESRCH（找不到程序）視為不存在
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM = process exists but we can't signal it (still alive)
    if (e.code === 'EPERM') return true;
    // ESRCH = no such process
    return false;
  }
}

/**
 * 送出指定 signal 給程序
 * 回傳是否成功（程序不存在視為成功）
 */
export function killProcess(pid: number, signal: string = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal as NodeJS.Signals);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ESRCH') return true; // 程序已不存在，視為成功
    return false;
  }
}

/**
 * 等待程序退出，最多等 timeoutMs 毫秒
 * 回傳 true 表示程序已退出，false 表示逾時
 */
export async function waitForExit(pid: number, timeoutMs: number = 5000): Promise<boolean> {
  const interval = 200;
  const iterations = Math.ceil(timeoutMs / interval);

  for (let i = 0; i < iterations; i++) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>(resolve => setTimeout(resolve, interval));
  }
  return !isProcessAlive(pid);
}

/**
 * 清理此專案的殘留程序（pkill -f）
 * 不拋出錯誤，靜默失敗
 */
export function cleanupStaleProcesses(projectDir: string): void {
  const patterns = [
    `${projectDir}/discord-bot/dist/listener`,
    `${projectDir}/discord-bot/dist/index`,
    `${projectDir}/pixel-office`,
  ];

  for (const pattern of patterns) {
    try {
      execSync(`pkill -f "${pattern}"`, { stdio: 'ignore' });
    } catch {
      // pkill 回傳非零代表找不到程序，這是正常的
    }
  }

  // 清理所有殘留的 listener.js 程序（防止舊版殘留造成重複回應）
  try {
    const result = execSync(
      `ps aux | grep "[l]istener.js" | awk '{print $2}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();

    if (result) {
      const pids = result.split('\n').filter(p => p.trim());
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid) && pid > 0) {
          killProcess(pid, 'SIGTERM');
        }
      }
    }
  } catch {
    // 靜默忽略
  }
}

/**
 * 刪除 PID 檔案（靜默失敗）
 */
export function removePidFile(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // 檔案不存在是正常的
  }
}

/**
 * 取得 PID 檔案的標準路徑
 */
export function getPidPaths(projectDir: string): { listener: string; pixel: string } {
  return {
    listener: path.join(projectDir, 'discord-bot', 'listener.pid'),
    pixel: path.join(projectDir, 'pixel-office', 'pixel.pid'),
  };
}
