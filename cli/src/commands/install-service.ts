import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { ok, fail, warn, info, prefix, bold, BOLD, RESET } from '../lib/colors.js';
import { readPid, isProcessAlive, getPidPaths } from '../lib/process-manager.js';

// ── 互動確認 ───────────────────────────────────────────────────────────────────

function askConfirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    process.stdout.write(`  ${question} [y/N] `);
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(buf.trim().toLowerCase() === 'y');
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', onData);
  });
}

// ── 查找 claude CLI 路徑 ───────────────────────────────────────────────────────

function findClaudePath(): string {
  try {
    const result = spawnSync('which', ['claude'], { encoding: 'utf-8' });
    if (result.status === 0 && result.stdout.trim()) {
      return path.dirname(result.stdout.trim());
    }
  } catch {
    // 忽略
  }
  return '';
}

// ── macOS launchd plist ────────────────────────────────────────────────────────

function generatePlist(projectDir: string): string {
  const nodePath = process.execPath;
  const supervisorJs = path.join(projectDir, 'discord-bot', 'dist', 'supervisor.js');
  const logPath = path.join(projectDir, 'discord-bot', 'listener.log');
  const homeDir = os.homedir();

  // 建構 PATH：包含 node 所在目錄 + claude 所在目錄 + 常見系統路徑
  const nodeBinDir = path.dirname(nodePath);
  const claudeDir = findClaudePath();
  const pathParts = [nodeBinDir];
  if (claudeDir && claudeDir !== nodeBinDir) {
    pathParts.push(claudeDir);
  }
  pathParts.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  const envPath = [...new Set(pathParts)].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aioffice.listener</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${supervisorJs}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${projectDir}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>${homeDir}</string>
  </dict>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logPath}</string>

  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

async function installMacos(projectDir: string): Promise<void> {
  const supervisorJs = path.join(projectDir, 'discord-bot', 'dist', 'supervisor.js');
  if (!fs.existsSync(supervisorJs)) {
    fail('找不到 discord-bot/dist/supervisor.js');
    info("請先執行 'office setup' 或 'npm run build' 進行建置。");
    process.exit(1);
  }

  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, 'com.aioffice.listener.plist');
  const plistContent = generatePlist(projectDir);

  console.log('');
  console.log(`${BOLD}  即將安裝 macOS LaunchAgent：${RESET}`);
  console.log(`  plist 路徑: ${plistPath}`);
  console.log(`  Node 路徑: ${process.execPath}`);
  console.log(`  Supervisor: ${supervisorJs}`);
  console.log(`  日誌: ${path.join(projectDir, 'discord-bot', 'listener.log')}`);
  console.log('');
  console.log(`${BOLD}  plist 內容預覽：${RESET}`);
  plistContent.split('\n').forEach(line => console.log(`    ${line}`));
  console.log('');

  const confirmed = await askConfirm('確認安裝？');
  if (!confirmed) {
    info('已取消安裝。');
    console.log('');
    return;
  }

  // 先停止手動啟動的程序（避免 PID 衝突）
  console.log('');
  info('正在停止現有手動啟動的程序...');
  const { listener: listenerPidFile, pixel: pixelPidFile } = getPidPaths(projectDir);
  const listenerPid = readPid(listenerPidFile);
  if (listenerPid !== null && isProcessAlive(listenerPid)) {
    try {
      process.kill(listenerPid, 'SIGTERM');
      ok(`已停止 Discord Listener（PID ${listenerPid}）`);
    } catch {
      warn(`停止 PID ${listenerPid} 失敗（可能已退出）`);
    }
    await new Promise<void>(r => setTimeout(r, 1500));
  } else {
    info('Discord Listener 未在手動運行');
  }
  // 清理 PID 檔
  try { fs.unlinkSync(listenerPidFile); } catch { /* 正常 */ }

  // 建立 LaunchAgents 目錄（通常已存在）
  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  // 若已安裝，先 unload
  if (fs.existsSync(plistPath)) {
    info('偵測到舊版 plist，先執行 launchctl unload...');
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch {
      // 忽略 unload 錯誤（可能尚未載入）
    }
  }

  // 寫入 plist
  fs.writeFileSync(plistPath, plistContent, { mode: 0o644 });
  ok(`已寫入 ${plistPath}`);

  // launchctl load
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
    ok('launchctl load 成功');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`launchctl load 失敗: ${msg}`);
    info('請手動執行：');
    info(`  launchctl load "${plistPath}"`);
    process.exit(1);
  }

  console.log('');
  ok('開機自啟服務已安裝！');
  info('服務將在下次登入時自動啟動，現在也已立即啟動。');
  info('查看日誌：office logs');
  info('停止服務：launchctl stop com.aioffice.listener');
  info('移除服務：office uninstall-service');
  console.log('');
}

// ── Linux systemd user service ─────────────────────────────────────────────────

function generateSystemdUnit(projectDir: string): string {
  const nodePath = process.execPath;
  const supervisorJs = path.join(projectDir, 'discord-bot', 'dist', 'supervisor.js');
  const logPath = path.join(projectDir, 'discord-bot', 'listener.log');

  return `[Unit]
Description=AI Office Discord Listener
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${supervisorJs}
WorkingDirectory=${projectDir}
Restart=on-failure
RestartSec=30
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

async function installLinux(projectDir: string): Promise<void> {
  const supervisorJs = path.join(projectDir, 'discord-bot', 'dist', 'supervisor.js');
  if (!fs.existsSync(supervisorJs)) {
    fail('找不到 discord-bot/dist/supervisor.js');
    info("請先執行 'office setup' 或 'npm run build' 進行建置。");
    process.exit(1);
  }

  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'ai-office.service');
  const unitContent = generateSystemdUnit(projectDir);

  console.log('');
  console.log(`${BOLD}  即將安裝 systemd user service：${RESET}`);
  console.log(`  service 路徑: ${servicePath}`);
  console.log(`  Node 路徑: ${process.execPath}`);
  console.log(`  Supervisor: ${supervisorJs}`);
  console.log('');
  console.log(`${BOLD}  unit 內容預覽：${RESET}`);
  unitContent.split('\n').forEach(line => console.log(`    ${line}`));
  console.log('');

  const confirmed = await askConfirm('確認安裝？');
  if (!confirmed) {
    info('已取消安裝。');
    console.log('');
    return;
  }

  // 先停止手動啟動的程序
  console.log('');
  info('正在停止現有手動啟動的程序...');
  const { listener: listenerPidFile } = getPidPaths(projectDir);
  const listenerPid = readPid(listenerPidFile);
  if (listenerPid !== null && isProcessAlive(listenerPid)) {
    try {
      process.kill(listenerPid, 'SIGTERM');
      ok(`已停止 Discord Listener（PID ${listenerPid}）`);
    } catch {
      warn(`停止 PID ${listenerPid} 失敗（可能已退出）`);
    }
    await new Promise<void>(r => setTimeout(r, 1500));
  } else {
    info('Discord Listener 未在手動運行');
  }
  try { fs.unlinkSync(listenerPidFile); } catch { /* 正常 */ }

  // 建立目錄
  if (!fs.existsSync(serviceDir)) {
    fs.mkdirSync(serviceDir, { recursive: true });
  }

  // 寫入 service 檔
  fs.writeFileSync(servicePath, unitContent, { mode: 0o644 });
  ok(`已寫入 ${servicePath}`);

  // daemon-reload + enable + start
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync('systemctl --user enable ai-office', { stdio: 'pipe' });
    ok('systemctl enable 成功');
    execSync('systemctl --user start ai-office', { stdio: 'pipe' });
    ok('systemctl start 成功');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`systemctl 操作失敗: ${msg}`);
    info('請手動執行：');
    info('  systemctl --user daemon-reload');
    info('  systemctl --user enable ai-office');
    info('  systemctl --user start ai-office');
    process.exit(1);
  }

  console.log('');
  ok('開機自啟服務已安裝！');
  info('查看狀態：systemctl --user status ai-office');
  info('查看日誌：office logs');
  info('移除服務：office uninstall-service');
  console.log('');
}

// ── Windows 提示 ───────────────────────────────────────────────────────────────

function installWindows(projectDir: string): void {
  const supervisorJs = path.join(projectDir, 'discord-bot', 'dist', 'supervisor.js');
  console.log('');
  warn('Windows 不支援自動安裝開機自啟服務。');
  console.log('');
  info('建議使用以下方式之一手動設定：');
  console.log('');
  info(`${BOLD}方式 1：工作排程器（Task Scheduler）${RESET}`);
  info('  1. 開啟「工作排程器」');
  info('  2. 建立基本工作，觸發器選「使用者登入時」');
  info(`  3. 動作設定：程式 = node.exe，引數 = "${supervisorJs}"`);
  console.log('');
  info(`${BOLD}方式 2：NSSM（Non-Sucking Service Manager）${RESET}`);
  info('  1. 下載 NSSM: https://nssm.cc/');
  info('  2. 執行：nssm install ai-office node.exe');
  info(`  3. 設定 AppParameters = "${supervisorJs}"`);
  info(`  4. 設定 AppDirectory = "${projectDir}"`);
  console.log('');
}

// ── 主要入口 ───────────────────────────────────────────────────────────────────

export async function cmdInstallService(projectDir: string): Promise<void> {
  console.log('');
  prefix('安裝開機自啟服務...');

  const platform = process.platform;

  switch (platform) {
    case 'darwin':
      await installMacos(projectDir);
      break;
    case 'linux':
      await installLinux(projectDir);
      break;
    case 'win32':
      installWindows(projectDir);
      break;
    default:
      warn(`不支援的平台: ${platform}`);
      info('目前僅支援 macOS（launchd）和 Linux（systemd）。');
      console.log('');
  }
}
