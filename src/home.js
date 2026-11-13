import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The user Home, shared by every project; on macOS and Linux it follows $HOME. */
export const userHome = () => join(process.env.HOME || homedir(), '.local', 'share', 'cuetake');

/**
 * The Home of the skill copy that ran: `CUETAKE_HOME`, which the skill's launcher sets for a skill installed
 * in a project, else the user Home (ADR 0011).
 */
export const home = () => process.env.CUETAKE_HOME ? resolve(process.env.CUETAKE_HOME) : userHome();

/**
 * The Home, created when missing. A project Home is created with a .gitignore that keeps its Takes out of
 * git; CueTake never writes that file again, so the user may change it.
 */
export async function ensureHome() {
  const dir = home();
  const created = await fs.mkdir(dir, { recursive: true });
  if (created && dir !== userHome()) await fs.writeFile(join(dir, '.gitignore'), 'takes/\n');
  return dir;
}
