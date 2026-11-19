/**
 * Schedules the daily poll on macOS with launchd.
 *
 *   pnpm launchd print              # show the plist, change nothing
 *   pnpm launchd install [--hour 9] # write ~/Library/LaunchAgents/…plist and load it
 *   pnpm launchd uninstall          # unload and remove it
 *
 * The job runs `node src/cli/poll.ts` — the same command as `pnpm poll` — with the repo as
 * working directory, so moving to a VPS is replacing this file with one cron line. launchd
 * runs a missed calendar slot when the Mac wakes, so a closed lid only delays the poll.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const LABEL = 'io.github.oguzsamsa.gatecheck';

export interface PlistOptions {
  label: string;
  node: string;
  repo: string;
  hour: number;
  minute: number;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildPlist(o: PlistOptions): string {
  const log = join(o.repo, 'data', 'logs', 'poll.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.node)}</string>
    <string>${xml(join(o.repo, 'src', 'cli', 'poll.ts'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.repo)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${o.hour}</integer>
    <key>Minute</key>
    <integer>${o.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hour: { type: 'string', default: '9' },
      minute: { type: 'string', default: '0' },
    },
  });
  const command = positionals[0] ?? 'print';
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    console.error('--hour must be 0–23 and --minute 0–59');
    process.exit(2);
  }

  const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
  const plist = buildPlist({ label: LABEL, node: process.execPath, repo, hour, minute });
  const path = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? ''}`;
  const unload = () => {
    try {
      execFileSync('launchctl', ['bootout', domain, path], { stdio: 'ignore' });
    } catch {
      // Not loaded — nothing to unload.
    }
  };

  switch (command) {
    case 'print':
      process.stdout.write(plist);
      break;
    case 'install':
      if (!existsSync(join(repo, 'config.json'))) {
        console.error('config.json is missing — create it from config.example.json first');
        process.exit(2);
      }
      mkdirSync(join(repo, 'data', 'logs'), { recursive: true });
      writeFileSync(path, plist);
      unload();
      execFileSync('launchctl', ['bootstrap', domain, path], { stdio: 'inherit' });
      console.log(`installed ${path}: polls daily at ${hour}:${String(minute).padStart(2, '0')}`);
      console.log(`run it now with: launchctl kickstart ${domain}/${LABEL}`);
      break;
    case 'uninstall':
      unload();
      rmSync(path, { force: true });
      console.log(`removed ${path}`);
      break;
    default:
      console.error('usage: pnpm launchd <print|install|uninstall> [--hour H] [--minute M]');
      process.exit(2);
  }
}

if (import.meta.main) main();
