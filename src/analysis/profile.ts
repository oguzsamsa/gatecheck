import { readFileSync } from 'node:fs';
import { ConfigError } from '../config.ts';

export function readProfile(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') throw new ConfigError(`profile file ${path} is empty`);
    return text;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`cannot read profile file ${path}`);
  }
}
