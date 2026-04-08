// ANSI 顏色 helper — 不依賴第三方套件

export const GREEN  = '\x1b[32m';
export const RED    = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const BOLD   = '\x1b[1m';
export const RESET  = '\x1b[0m';

export function ok(msg: string):   void { console.log(`  ${GREEN}[OK]${RESET}  ${msg}`); }
export function fail(msg: string): void { console.log(`  ${RED}[FAIL]${RESET} ${msg}`); }
export function warn(msg: string): void { console.log(`  ${YELLOW}[WARN]${RESET} ${msg}`); }
export function info(msg: string): void { console.log(`  ${msg}`); }
export function prefix(msg: string): void { console.log(`${BOLD}[office]${RESET} ${msg}`); }

export function bold(msg: string): string { return `${BOLD}${msg}${RESET}`; }
export function green(msg: string): string { return `${GREEN}${msg}${RESET}`; }
export function red(msg: string): string { return `${RED}${msg}${RESET}`; }
export function yellow(msg: string): string { return `${YELLOW}${msg}${RESET}`; }
