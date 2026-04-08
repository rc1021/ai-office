import fs from 'node:fs';
import path from 'node:path';
import { readPid, isProcessAlive, getPidPaths } from '../lib/process-manager.js';
import { bold, green, red, yellow, RESET } from '../lib/colors.js';

export async function cmdStatus(projectDir: string): Promise<void> {
  console.log('');
  console.log(`  ${bold('AI Office — 系統狀態')}`);
  console.log('  ==================================');
  console.log('');

  let anyIssue = false;

  const { listener: listenerPidFile, pixel: pixelPidFile } = getPidPaths(projectDir);

  // ── 1. Discord Listener ───────────────────────────────────────────────────────
  console.log(`  ${bold('Discord Listener')}`);
  const listenerPid = readPid(listenerPidFile);
  if (listenerPid !== null) {
    if (isProcessAlive(listenerPid)) {
      const logFile = path.join(projectDir, 'discord-bot', 'listener.log');
      console.log(`    狀態: ${green('● 運行中')}（PID ${listenerPid}）`);
      console.log(`    日誌: ${logFile}`);
    } else {
      console.log(`    狀態: ${red('● 已停止')}（PID 檔案存在但程序不存在，PID ${listenerPid}）`);
      anyIssue = true;
    }
  } else {
    console.log(`    狀態: ${red('● 已停止')}（找不到 PID 檔案）`);
    anyIssue = true;
  }
  console.log('');

  // ── 2. Pixel Office ───────────────────────────────────────────────────────────
  const pixelPort = 3847;
  console.log(`  ${bold('Pixel Office')}`);

  const pixelPid = readPid(pixelPidFile);
  let pixelPidOk = false;

  if (pixelPid !== null) {
    if (isProcessAlive(pixelPid)) {
      pixelPidOk = true;
      console.log(`    程序: ${green('● 運行中')}（PID ${pixelPid}）`);
    } else {
      console.log(`    程序: ${yellow('● PID 失效')}（PID ${pixelPid} 不存在）`);
    }
  } else {
    console.log(`    程序: ${yellow('● 無 PID 檔案')}`);
  }

  // 使用 Node.js 內建 fetch 檢查連接埠
  let portOk = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`http://localhost:${pixelPort}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    portOk = response.ok || response.status > 0; // 只要有回應即可
  } catch {
    portOk = false;
  }

  if (portOk) {
    console.log(`    連接埠 ${pixelPort}: ${green('● 回應中')}  →  http://localhost:${pixelPort}`);
  } else {
    if (pixelPidOk) {
      console.log(`    連接埠 ${pixelPort}: ${yellow('● 無回應')}（程序存在但埠未開放）`);
    } else {
      console.log(`    連接埠 ${pixelPort}: ${red('● 未運行')}`);
      anyIssue = true;
    }
  }
  console.log('');

  // ── 3. Coordination DB ────────────────────────────────────────────────────────
  const dbPath = path.join(projectDir, '.ai-office', 'state', 'coordination.db');
  console.log(`  ${bold('Coordination DB')}`);
  if (fs.existsSync(dbPath)) {
    const stat = fs.statSync(dbPath);
    const sizeKb = (stat.size / 1024).toFixed(1);
    const sizeStr = stat.size >= 1024 * 1024
      ? `${(stat.size / 1024 / 1024).toFixed(1)}M`
      : `${sizeKb}K`;
    console.log(`    狀態: ${green('● 存在')}（${sizeStr}）`);
    console.log(`    路徑: ${dbPath}`);
  } else {
    console.log(`    狀態: ${yellow('● 尚未建立')}（首次啟動後會自動產生）`);
  }
  console.log('');

  // ── 4. ngrok 隧道 ─────────────────────────────────────────────────────────────
  const ngrokUrlFile = path.join(projectDir, '.ai-office', 'state', 'ngrok-url.txt');
  console.log(`  ${bold('ngrok 隧道')}`);
  if (fs.existsSync(ngrokUrlFile)) {
    let ngrokUrl = '';
    try {
      ngrokUrl = fs.readFileSync(ngrokUrlFile, 'utf-8').trim();
    } catch {
      // 靜默忽略
    }
    if (ngrokUrl) {
      console.log(`    狀態: ${green('● 已建立')}`);
      console.log(`    URL: ${ngrokUrl}`);
    } else {
      console.log(`    狀態: ${yellow('● URL 檔案空白')}`);
    }
  } else {
    console.log(`    狀態: ${yellow('● 未啟用')}（ngrok-url.txt 不存在）`);
  }
  console.log('');

  // ── 5. 綜合摘要 ───────────────────────────────────────────────────────────────
  if (!anyIssue) {
    console.log(`  \x1b[32m\x1b[1m系統運行正常。${RESET}`);
  } else {
    console.log(`  \x1b[33m\x1b[1m有元件未運行。執行 'office start' 可啟動服務。${RESET}`);
  }
  console.log('');
}
