import fs from 'node:fs';
import path from 'node:path';
import {
  readPid,
  isProcessAlive,
  killProcess,
  waitForExit,
  removePidFile,
  cleanupStaleProcesses,
  getPidPaths,
} from '../lib/process-manager.js';
import { ok, info, prefix } from '../lib/colors.js';

export async function cmdStop(projectDir: string): Promise<void> {
  console.log('');
  prefix('停止所有程序...');
  console.log('');

  const { listener: listenerPidFile, pixel: pixelPidFile } = getPidPaths(projectDir);

  // ── 停止 Discord Listener ─────────────────────────────────────────────────────
  const listenerPid = readPid(listenerPidFile);
  if (listenerPid !== null) {
    if (isProcessAlive(listenerPid)) {
      // Graceful shutdown: 先 SIGTERM
      killProcess(listenerPid, 'SIGTERM');
      const exited = await waitForExit(listenerPid, 5000);
      if (exited) {
        ok(`已停止 Discord Listener（PID ${listenerPid}）`);
      } else {
        // SIGTERM 後 5 秒仍未退出，發送 SIGKILL
        killProcess(listenerPid, 'SIGKILL');
        await waitForExit(listenerPid, 2000);
        ok(`已強制停止 Discord Listener（PID ${listenerPid}，SIGKILL）`);
      }
    } else {
      info(`Discord Listener PID ${listenerPid} 已不存在（跳過）`);
    }
    removePidFile(listenerPidFile);
  } else {
    info('Discord Listener 未在運行（找不到 PID 檔案）');
  }

  // ── 停止 Pixel Office ─────────────────────────────────────────────────────────
  const pixelPid = readPid(pixelPidFile);
  if (pixelPid !== null) {
    if (isProcessAlive(pixelPid)) {
      killProcess(pixelPid, 'SIGTERM');
      const exited = await waitForExit(pixelPid, 5000);
      if (exited) {
        ok(`已停止 Pixel Office（PID ${pixelPid}）`);
      } else {
        killProcess(pixelPid, 'SIGKILL');
        await waitForExit(pixelPid, 2000);
        ok(`已強制停止 Pixel Office（PID ${pixelPid}，SIGKILL）`);
      }
    } else {
      info(`Pixel Office PID ${pixelPid} 已不存在（跳過）`);
    }
    removePidFile(pixelPidFile);
  } else {
    info('Pixel Office 未在運行（找不到 PID 檔案）');
  }

  // ── 清理殘留程序 ──────────────────────────────────────────────────────────────
  cleanupStaleProcesses(projectDir);

  // ── 清除 ngrok URL 快取 ───────────────────────────────────────────────────────
  const ngrokUrlFile = path.join(projectDir, '.ai-office', 'state', 'ngrok-url.txt');
  try {
    fs.unlinkSync(ngrokUrlFile);
    ok('已清除 ngrok URL 快取');
  } catch {
    // 檔案不存在是正常的
  }

  console.log('');
  ok('所有程序已停止。');
  console.log('');
}
