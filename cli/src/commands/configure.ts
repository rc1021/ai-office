import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { bold, green, yellow, RESET, BOLD, YELLOW } from '../lib/colors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type ConfigKey =
  | 'office-name'
  | 'language'
  | 'timezone'
  | 'max-workers'
  | 'discord-token'
  | 'guild-id'
  | 'client-id'
  | 'owner-user-id'
  | 'ngrok-mode'
  | 'ngrok-token'
  | 'pixel-user'
  | 'pixel-pass'
  | 'pixel-url';

interface ConfigEntry {
  key: ConfigKey;
  label: string;
  file: string;
  secret?: boolean;
  allowed?: string[];
  isInt?: boolean;
}

const CONFIG_ENTRIES: ConfigEntry[] = [
  { key: 'office-name',    label: 'office-name',    file: 'config/office.yaml' },
  { key: 'language',       label: 'language',       file: 'config/office.yaml', allowed: ['zh-TW', 'en', 'ja'] },
  { key: 'timezone',       label: 'timezone',       file: 'config/office.yaml' },
  { key: 'max-workers',    label: 'max-workers',    file: 'config/office.yaml', isInt: true },
  { key: 'discord-token',  label: 'discord-token',  file: 'discord-bot/.env',   secret: true },
  { key: 'guild-id',       label: 'guild-id',       file: 'discord-bot/.env' },
  { key: 'client-id',      label: 'client-id',      file: 'discord-bot/.env' },
  { key: 'owner-user-id',  label: 'owner-user-id',  file: 'discord-bot/.env' },
  { key: 'ngrok-mode',     label: 'ngrok-mode',     file: 'pixel-office/.env',  allowed: ['internal', 'external', 'custom', 'disabled'] },
  { key: 'ngrok-token',    label: 'ngrok-token',    file: 'pixel-office/.env',  secret: true },
  { key: 'pixel-user',     label: 'pixel-user',     file: 'pixel-office/.env' },
  { key: 'pixel-pass',     label: 'pixel-pass',     file: 'pixel-office/.env',  secret: true },
  { key: 'pixel-url',      label: 'pixel-url',      file: 'pixel-office/.env' },
];

// ── File readers ──────────────────────────────────────────────────────────────

function readYamlField(filePath: string, field: string): string {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]*)"?`, 'm'));
  return match ? match[1].trim() : '';
}

function readEnvField(filePath: string, key: string): string {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim();
    }
  }
  return '';
}

function readMcpJsonField(filePath: string, field: string): string {
  if (!fs.existsSync(filePath)) return '';
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const servers = (obj['mcpServers'] as Record<string, unknown> | undefined) ?? {};
    const discord = (servers['ai-office-discord'] as Record<string, unknown> | undefined) ?? {};
    const env = (discord['env'] as Record<string, string> | undefined) ?? {};
    return env[field] ?? '';
  } catch {
    return '';
  }
}

function getCurrentValue(projectDir: string, key: ConfigKey): string {
  switch (key) {
    case 'office-name':
      return readYamlField(path.join(projectDir, 'config', 'office.yaml'), 'name');
    case 'language':
      return readYamlField(path.join(projectDir, 'config', 'office.yaml'), 'language');
    case 'timezone':
      return readYamlField(path.join(projectDir, 'config', 'office.yaml'), 'timezone');
    case 'max-workers':
      return readYamlField(path.join(projectDir, 'config', 'office.yaml'), 'max_concurrent');
    case 'discord-token':
      return readEnvField(path.join(projectDir, 'discord-bot', '.env'), 'DISCORD_BOT_TOKEN');
    case 'guild-id':
      return readEnvField(path.join(projectDir, 'discord-bot', '.env'), 'DISCORD_GUILD_ID');
    case 'client-id':
      return readEnvField(path.join(projectDir, 'discord-bot', '.env'), 'DISCORD_CLIENT_ID');
    case 'owner-user-id':
      return readEnvField(path.join(projectDir, 'discord-bot', '.env'), 'DISCORD_OWNER_USER_ID');
    case 'ngrok-mode':
      return readEnvField(path.join(projectDir, 'pixel-office', '.env'), 'NGROK_MODE');
    case 'ngrok-token':
      return readEnvField(path.join(projectDir, 'pixel-office', '.env'), 'NGROK_AUTHTOKEN');
    case 'pixel-user':
      return readEnvField(path.join(projectDir, 'pixel-office', '.env'), 'PIXEL_AUTH_USER');
    case 'pixel-pass':
      return readEnvField(path.join(projectDir, 'pixel-office', '.env'), 'PIXEL_AUTH_PASS');
    case 'pixel-url':
      return readEnvField(path.join(projectDir, 'pixel-office', '.env'), 'PIXEL_PUBLIC_URL');
  }
}

function maskValue(value: string, secret: boolean): string {
  if (!value) return '(not set)';
  if (secret) return '****set****';
  return value;
}

// ── File writers ──────────────────────────────────────────────────────────────

function updateYamlField(filePath: string, field: string, value: string): void {
  const examplePath = `${filePath}.example`;
  if (!fs.existsSync(filePath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, filePath);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  let content = fs.readFileSync(filePath, 'utf-8');
  const re = new RegExp(`^(${field}:\\s*)("?)[^"\\n]*("?)`, 'm');
  if (re.test(content)) {
    // Determine if original used quotes
    const match = content.match(new RegExp(`^${field}:\\s*("?)`, 'm'));
    const quote = match?.[1] === '"' ? '"' : '';
    content = content.replace(
      new RegExp(`^(${field}:)\\s*"?[^"\\n]*"?`, 'm'),
      `$1 ${quote}${value}${quote}`
    );
  } else {
    content += `\n${field}: "${value}"\n`;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

function updateEnvField(filePath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }
  const lines = content.split('\n');
  let found = false;
  const updated = lines.map(line => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    // Append before trailing empty line
    if (updated[updated.length - 1] === '') {
      updated.splice(updated.length - 1, 0, `${key}=${value}`);
    } else {
      updated.push(`${key}=${value}`);
    }
  }
  // Ensure the file ends with a single newline
  const result = updated.join('\n').replace(/\n+$/, '') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, result, 'utf-8');
}

function updateMcpJsonField(filePath: string, field: string, value: string): void {
  if (!fs.existsSync(filePath)) return; // skip silently if .mcp.json doesn't exist
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return; // malformed JSON, skip
  }
  const servers = (obj['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  const discord = (servers['ai-office-discord'] as Record<string, unknown> | undefined) ?? {};
  const env = (discord['env'] as Record<string, string> | undefined) ?? {};
  env[field] = value;
  discord['env'] = env;
  servers['ai-office-discord'] = discord;
  obj['mcpServers'] = servers;
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

// ── Apply a single key=value ──────────────────────────────────────────────────

function applyValue(projectDir: string, key: ConfigKey, value: string): void {
  const yamlPath      = path.join(projectDir, 'config', 'office.yaml');
  const discordEnvPath = path.join(projectDir, 'discord-bot', '.env');
  const mcpJsonPath    = path.join(projectDir, '.mcp.json');
  const pixelEnvPath   = path.join(projectDir, 'pixel-office', '.env');

  switch (key) {
    case 'office-name':
      updateYamlField(yamlPath, 'name', value);
      break;
    case 'language':
      updateYamlField(yamlPath, 'language', value);
      break;
    case 'timezone':
      updateYamlField(yamlPath, 'timezone', value);
      break;
    case 'max-workers':
      updateYamlField(yamlPath, 'max_concurrent', value);
      break;
    case 'discord-token':
      updateEnvField(discordEnvPath, 'DISCORD_BOT_TOKEN', value);
      updateMcpJsonField(mcpJsonPath, 'DISCORD_BOT_TOKEN', value);
      break;
    case 'guild-id':
      updateEnvField(discordEnvPath, 'DISCORD_GUILD_ID', value);
      updateMcpJsonField(mcpJsonPath, 'DISCORD_GUILD_ID', value);
      break;
    case 'client-id':
      updateEnvField(discordEnvPath, 'DISCORD_CLIENT_ID', value);
      break;
    case 'owner-user-id':
      updateEnvField(discordEnvPath, 'DISCORD_OWNER_USER_ID', value);
      break;
    case 'ngrok-mode':
      updateEnvField(pixelEnvPath, 'NGROK_MODE', value);
      break;
    case 'ngrok-token':
      updateEnvField(pixelEnvPath, 'NGROK_AUTHTOKEN', value);
      break;
    case 'pixel-user':
      updateEnvField(pixelEnvPath, 'PIXEL_AUTH_USER', value);
      break;
    case 'pixel-pass':
      updateEnvField(pixelEnvPath, 'PIXEL_AUTH_PASS', value);
      break;
    case 'pixel-url':
      updateEnvField(pixelEnvPath, 'PIXEL_PUBLIC_URL', value);
      break;
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateValue(entry: ConfigEntry, value: string): string | null {
  if (entry.isInt) {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1) return `必須是正整數 (got: "${value}")`;
    return null;
  }
  if (entry.allowed && !entry.allowed.includes(value)) {
    return `允許值: ${entry.allowed.join(', ')} (got: "${value}")`;
  }
  return null;
}

// ── Interactive menu ──────────────────────────────────────────────────────────

async function interactiveMenu(projectDir: string): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log('');
    console.log(`  ${bold('AI Office — Configure')}`);
    console.log('  ==================================');
    console.log('');
    console.log('  Current configuration:');

    const values: string[] = CONFIG_ENTRIES.map(e => getCurrentValue(projectDir, e.key));

    for (let i = 0; i < CONFIG_ENTRIES.length; i++) {
      const e = CONFIG_ENTRIES[i];
      const num = String(i + 1).padStart(2);
      const keyCol = e.key.padEnd(14);
      const valCol = maskValue(values[i], !!e.secret).padEnd(20);
      console.log(`  ${num}. ${keyCol} ${valCol} [${e.file}]`);
    }
    console.log('   0. Exit');
    console.log('');

    const choiceStr = await rl.question('  Choose a key to configure [0]: ');
    const choice = parseInt(choiceStr.trim() || '0', 10);

    if (isNaN(choice) || choice === 0) {
      console.log('');
      return;
    }

    if (choice < 1 || choice > CONFIG_ENTRIES.length) {
      console.log(`\n  ${YELLOW}[WARN]${RESET} 無效選項: ${choice}\n`);
      return;
    }

    const entry = CONFIG_ENTRIES[choice - 1];
    const current = values[choice - 1];
    await promptAndApply(projectDir, entry, current, rl);

  } finally {
    rl.close();
  }
}

async function promptAndApply(
  projectDir: string,
  entry: ConfigEntry,
  current: string,
  rl: readline.Interface,
): Promise<void> {
  const display = maskValue(current, !!entry.secret);
  let hint = `[current: ${display}]`;
  if (entry.allowed) {
    hint += ` (${entry.allowed.join('/')})`;
  }

  const answer = await rl.question(`  ${bold(entry.key)} ${hint}: `);
  const value = answer.trim();

  if (value === '') {
    console.log(`\n  ${YELLOW}[WARN]${RESET} 未輸入任何值，保留原設定。\n`);
    return;
  }

  const err = validateValue(entry, value);
  if (err) {
    console.log(`\n  \x1b[31m[FAIL]\x1b[0m 驗證失敗: ${err}\n`);
    return;
  }

  applyValue(projectDir, entry.key, value);
  const display2 = maskValue(value, !!entry.secret);
  console.log(`\n  \x1b[32m[OK]\x1b[0m  ${entry.key} = ${display2}  (${entry.file})\n`);
}

// ── Standalone key prompt ─────────────────────────────────────────────────────

async function promptForKey(projectDir: string, key: ConfigKey): Promise<void> {
  const entry = CONFIG_ENTRIES.find(e => e.key === key);
  if (!entry) {
    console.error(`\x1b[31m[ERROR]\x1b[0m 未知的 key: '${key}'`);
    console.error(`  可用 key: ${CONFIG_ENTRIES.map(e => e.key).join(', ')}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const current = getCurrentValue(projectDir, key);
    await promptAndApply(projectDir, entry, current, rl);
  } finally {
    rl.close();
  }
}

// ── Direct set ────────────────────────────────────────────────────────────────

function directSet(projectDir: string, key: ConfigKey, value: string): void {
  const entry = CONFIG_ENTRIES.find(e => e.key === key);
  if (!entry) {
    console.error(`\x1b[31m[ERROR]\x1b[0m 未知的 key: '${key}'`);
    console.error(`  可用 key: ${CONFIG_ENTRIES.map(e => e.key).join(', ')}`);
    process.exit(1);
  }

  const err = validateValue(entry, value);
  if (err) {
    console.error(`\x1b[31m[ERROR]\x1b[0m 驗證失敗: ${err}`);
    process.exit(1);
  }

  applyValue(projectDir, entry.key, value);
  const display = maskValue(value, !!entry.secret);
  console.log(`  \x1b[32m[OK]\x1b[0m  ${entry.key} = ${display}  (${entry.file})`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function cmdConfigure(projectDir: string, args: string[]): Promise<void> {
  const [rawKey, rawValue] = args;

  // --help / -h
  if (rawKey === '--help' || rawKey === '-h') {
    console.log('');
    console.log(`  ${bold('Usage:')} office configure [key] [value]`);
    console.log('');
    console.log('  可用 key:');
    for (const e of CONFIG_ENTRIES) {
      const allowed = e.allowed ? `  (${e.allowed.join('/')})` : '';
      console.log(`    ${e.key.padEnd(16)} ${e.file}${allowed}`);
    }
    console.log('');
    return;
  }

  if (!rawKey) {
    // No args → interactive menu
    await interactiveMenu(projectDir);
    return;
  }

  const key = rawKey as ConfigKey;

  if (!rawValue) {
    // Key only → prompt for value
    await promptForKey(projectDir, key);
    return;
  }

  // Key + value → direct set
  directSet(projectDir, key, rawValue);
}
