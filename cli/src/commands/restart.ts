import { cmdStop } from './stop.js';
import { cmdStart } from './start.js';

export async function cmdRestart(projectDir: string): Promise<void> {
  await cmdStop(projectDir);
  await cmdStart(projectDir);
}
