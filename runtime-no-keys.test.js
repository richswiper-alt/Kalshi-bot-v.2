const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const projectRoot = __dirname;

test('bot starts in no-credentials mode without crashing', () => {
  const env = {
    ...process.env,
    TELEGRAM_TOKEN: '',
    KALSHI_API_KEY: '',
    YOUR_TELEGRAM_ID: '',
    PUBLIC_TELEGRAM_ID: '',
    KALSHI_KEY_PATH: '/tmp/does-not-exist.pem',
    DRY_RUN: 'true',
    AUTO_EXECUTE: 'false',
    OWNER_MODE: 'false'
  };

  const result = spawnSync(process.execPath, ['index.js'], {
    cwd: projectRoot,
    env,
    timeout: 15000,
    encoding: 'utf8'
  });

  assert.ok(result.stdout || result.stderr, 'expected bot output');
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.match(output, /no-credentials|limited mode|safe mode|startup/i, {
    message: `expected startup banner for no-credentials mode, got: ${output}`
  });
  assert.doesNotMatch(output, /ETELEGRAM|authentication_error/, {
    message: `offline mode attempted a credentialed service: ${output}`
  });
  assert.notStrictEqual(result.status, 1, `unexpected exit code 1. Output: ${output}`);
});
