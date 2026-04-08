import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  readPid,
  writePid,
  isProcessAlive,
  removePidFile,
  getPidPaths,
} from '../lib/process-manager.js';
import { ok, fail, warn, info, prefix } from '../lib/colors.js';

export async function cmdStart(projectDir: string): Promise<void> {
  console.log('');
  prefix('啟動 Discord Listener daemon...');
  console.log('');

  const { listener: listenerPidFile } = getPidPaths(projectDir);

  // 檢查是否已在運行
  const existingPid = readPid(listenerPidFile);
  if (existingPid !== null) {
    if (isProcessAlive(existingPid)) {
      warn(`Discord Listener 已在運行（PID ${existingPid}）`);
      info("若要重新啟動，請先執行 'office stop' 再執行 'office start'");
      info("或直接執行 'office restart'");
      console.log('');
      return;
    } else {
      // PID 檔案過期，清除
      removePidFile(listenerPidFile);
    }
  }

  // 驗證建置存在（優先使用 supervisor.js，fallback 到 listener.js）
  const supervisorJs = path.join(projectDir, 'discord-bot', 'dist', 'supervisor.js');
  const listenerJs = path.join(projectDir, 'discord-bot', 'dist', 'listener.js');
  const useSupervisor = fs.existsSync(supervisorJs);
  const targetJs = useSupervisor ? supervisorJs : listenerJs;

  if (!fs.existsSync(targetJs)) {
    fail('找不到 discord-bot/dist/supervisor.js 或 listener.js');
    info("請先執行 'office setup' 或 'office update' 進行建置。");
    console.log('');
    process.exit(1);
  }

  if (useSupervisor) {
    info('使用 Supervisor 模式（自動重啟保護）');
  } else {
    info('Supervisor 未建置，回退至直接啟動 listener');
  }

  const listenerLog = path.join(projectDir, 'discord-bot', 'listener.log');

  // 確保 log 目錄存在
  const logDir = path.dirname(listenerLog);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // 開啟 log 檔（append 模式）
  const logFd = fs.openSync(listenerLog, 'a');

  // 背景啟動 supervisor（或 listener），detached，stdio 導向 log 檔
  const child = spawn('node', [targetJs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: projectDir,
  });

  // 關閉父程序對 log fd 的參考，讓子程序完全獨立
  child.unref();
  fs.closeSync(logFd);

  const listenerPid = child.pid;
  if (listenerPid === undefined) {
    warn('Discord Listener 啟動失敗（無法取得 PID）。');
    info(`請檢查日誌: ${listenerLog}`);
    console.log('');
    return;
  }

  // 短暫等待以偵測立即崩潰（2 秒）
  // supervisor.js 會自行寫入 PID 檔；listener.js 則由此處寫入
  await new Promise<void>(resolve => setTimeout(resolve, 2000));

  if (isProcessAlive(listenerPid)) {
    // supervisor 自行寫 PID；listener fallback 時才由這裡寫
    if (!useSupervisor) {
      writePid(listenerPidFile, listenerPid);
    }
    const label = useSupervisor ? 'Supervisor' : 'Discord Listener';
    ok(`${label} 已啟動（PID ${listenerPid}）`);
    info(`日誌: ${listenerLog}`);
    console.log('');

    // 顯示 ngrok 模式資訊
    const envFile = path.join(projectDir, 'pixel-office', '.env');
    let ngrokMode = '';
    try {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      const match = envContent.match(/^NGROK_MODE=(.+)$/m);
      if (match) ngrokMode = match[1].trim();
    } catch {
      // .env 可能不存在
    }

    if (ngrokMode && ngrokMode !== 'disabled') {
      info('Pixel Office 會隨 listener 自動啟動');
      info(`（ngrok 模式: ${ngrokMode} — 公開 URL 將發送至 Discord #general）`);
    } else {
      info('Pixel Office 本機位址: http://localhost:3847');
    }
  } else {
    warn('Discord Listener 可能啟動失敗。');
    info(`請檢查日誌: ${listenerLog}`);
    info('手動啟動方式:');
    const manualTarget = useSupervisor ? 'discord-bot/dist/supervisor.js' : 'discord-bot/dist/listener.js';
    info(`  cd ${projectDir} && node ${manualTarget}`);
  }

  console.log('');
}
