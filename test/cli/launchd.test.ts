import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlist } from '../../src/cli/launchd.ts';

const options = {
  label: 'io.github.example.gatecheck',
  node: '/opt/node/bin/node',
  repo: '/Users/me/My Projects/gatecheck & co',
  hour: 9,
  minute: 5,
};

describe('buildPlist', () => {
  it('runs the poll script daily from the repo, logging to data/logs', () => {
    const plist = buildPlist(options);
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain(
      '<string>/Users/me/My Projects/gatecheck &amp; co/src/cli/poll.ts</string>',
    );
    expect(plist).toContain('<key>Hour</key>\n    <integer>9</integer>');
    expect(plist).toContain('<key>Minute</key>\n    <integer>5</integer>');
    expect(plist).toContain('gatecheck &amp; co/data/logs/poll.log');
  });

  it.runIf(process.platform === 'darwin')('is a valid property list', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gatecheck-')), 'job.plist');
    writeFileSync(file, buildPlist(options));
    expect(execFileSync('plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
  });
});
