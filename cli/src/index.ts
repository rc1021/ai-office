import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdStart } from './commands/start.js';
import { cmdStop } from './commands/stop.js';
import { cmdStatus } from './commands/status.js';
import { cmdRestart } from './commands/restart.js';
import { cmdInstallService } from './commands/install-service.js';
import { cmdUninstallService } from './commands/uninstall-service.js';
import { cmdConfigure } from './commands/configure.js';

// ── PROJECT_DIR 解析 ──────────────────────────────────────────────────────────
// 優先使用環境變數（由 bin/office 傳入），否則推算：cli/dist/index.js → 上兩層
function resolveProjectDir(): string {
  if (process.env['PROJECT_DIR']) {
    return path.resolve(process.env['PROJECT_DIR']);
  }
  // __dirname = cli/dist → 上一層 cli/ → 再上一層 project root
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '..', '..');
}

// ── 指令說明 ──────────────────────────────────────────────────────────────────
function showHelp(): void {
  console.log('');
  console.log('  \x1b[1mAI Office CLI\x1b[0m');
  console.log('  使用方式: office <指令>');
  console.log('');
  console.log('  可用指令:');
  console.log('    start              啟動 Discord Listener daemon');
  console.log('    stop               停止所有運行中的程序');
  console.log('    restart            停止後重新啟動');
  console.log('    status             顯示各元件目前狀態');
  console.log('    install-service    安裝開機自啟服務（launchd / systemd）');
  console.log('    uninstall-service  移除開機自啟服務');
  console.log('    configure [key] [value]  設定單一變數（不走完整 wizard）');
  console.log('');
}

// ── 主程式 ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const subcommand = process.argv[2] ?? '';
  const projectDir = resolveProjectDir();

  switch (subcommand) {
    case 'start':
      await cmdStart(projectDir);
      break;
    case 'stop':
      await cmdStop(projectDir);
      break;
    case 'status':
      await cmdStatus(projectDir);
      break;
    case 'restart':
      await cmdRestart(projectDir);
      break;
    case 'install-service':
      await cmdInstallService(projectDir);
      break;
    case 'uninstall-service':
      await cmdUninstallService();
      break;
    case 'configure':
      await cmdConfigure(projectDir, process.argv.slice(3));
      break;
    case 'help':
    case '--help':
    case '-h':
    case '':
      showHelp();
      break;
    default:
      console.error(`\x1b[1m[office]\x1b[0m 未知指令: '${subcommand}'`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('\x1b[31m[ERROR]\x1b[0m', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
