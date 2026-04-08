import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ok, fail, warn, info, prefix } from '../lib/colors.js';

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

// ── macOS launchd ──────────────────────────────────────────────────────────────

async function uninstallMacos(): Promise<void> {
  const plistPath = path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    'com.aioffice.listener.plist',
  );

  if (!fs.existsSync(plistPath)) {
    warn('找不到 LaunchAgent plist 檔案，可能尚未安裝。');
    info(`預期路徑: ${plistPath}`);
    console.log('');
    return;
  }

  console.log('');
  info(`即將移除 macOS LaunchAgent：`);
  info(`  plist 路徑: ${plistPath}`);
  console.log('');

  const confirmed = await askConfirm('確認移除？');
  if (!confirmed) {
    info('已取消移除。');
    console.log('');
    return;
  }

  console.log('');

  // launchctl unload
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    ok('launchctl unload 成功（服務已停止）');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`launchctl unload 回報錯誤（可能已停止）: ${msg}`);
  }

  // 刪除 plist 檔
  try {
    fs.unlinkSync(plistPath);
    ok(`已刪除 ${plistPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`刪除 plist 失敗: ${msg}`);
    process.exit(1);
  }

  console.log('');
  ok('開機自啟服務已移除。');
  info("若要再次啟用，請執行 'office install-service'。");
  info("若要手動啟動，請執行 'office start'。");
  console.log('');
}

// ── Linux systemd ──────────────────────────────────────────────────────────────

async function uninstallLinux(): Promise<void> {
  const servicePath = path.join(
    os.homedir(),
    '.config',
    'systemd',
    'user',
    'ai-office.service',
  );

  if (!fs.existsSync(servicePath)) {
    warn('找不到 systemd user service 檔案，可能尚未安裝。');
    info(`預期路徑: ${servicePath}`);
    console.log('');
    return;
  }

  console.log('');
  info(`即將移除 systemd user service：`);
  info(`  service 路徑: ${servicePath}`);
  console.log('');

  const confirmed = await askConfirm('確認移除？');
  if (!confirmed) {
    info('已取消移除。');
    console.log('');
    return;
  }

  console.log('');

  // stop + disable
  try {
    execSync('systemctl --user stop ai-office', { stdio: 'pipe' });
    ok('systemctl stop 成功');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`systemctl stop 回報錯誤（可能已停止）: ${msg}`);
  }

  try {
    execSync('systemctl --user disable ai-office', { stdio: 'pipe' });
    ok('systemctl disable 成功');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`systemctl disable 回報錯誤: ${msg}`);
  }

  // 刪除 service 檔
  try {
    fs.unlinkSync(servicePath);
    ok(`已刪除 ${servicePath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`刪除 service 檔失敗: ${msg}`);
    process.exit(1);
  }

  // daemon-reload
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    ok('systemctl daemon-reload 成功');
  } catch {
    // 忽略
  }

  console.log('');
  ok('開機自啟服務已移除。');
  info("若要再次啟用，請執行 'office install-service'。");
  info("若要手動啟動，請執行 'office start'。");
  console.log('');
}

// ── Windows 提示 ───────────────────────────────────────────────────────────────

function uninstallWindows(): void {
  console.log('');
  warn('Windows 不支援自動移除服務。');
  info('請手動使用「工作排程器」或 NSSM 移除 ai-office 服務。');
  console.log('');
}

// ── 主要入口 ───────────────────────────────────────────────────────────────────

export async function cmdUninstallService(): Promise<void> {
  console.log('');
  prefix('移除開機自啟服務...');

  const platform = process.platform;

  switch (platform) {
    case 'darwin':
      await uninstallMacos();
      break;
    case 'linux':
      await uninstallLinux();
      break;
    case 'win32':
      uninstallWindows();
      break;
    default:
      warn(`不支援的平台: ${platform}`);
      console.log('');
  }
}
