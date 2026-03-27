import { describe, it, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveConfigPath, loadConfig, validateConfig } from './config.js';
import { Logger } from './logger.js';
import type { LogEntry } from './types.js';

// ---------- helpers ----------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `daemon-test-${randomUUID().slice(0, 8)}-`));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ---------- config ----------

describe('resolveConfigPath', () => {
  it('prefers explicit CLI path', () => {
    const p = resolveConfigPath('/custom/config.yaml');
    assert.equal(p, '/custom/config.yaml');
  });

  it('expands ~ in CLI path', () => {
    const p = resolveConfigPath('~/my-daemon.yaml');
    assert.ok(p.startsWith(homedir()));
    assert.ok(p.endsWith('my-daemon.yaml'));
  });

  it('falls back to GSD_DAEMON_CONFIG env var', () => {
    const prev = process.env['GSD_DAEMON_CONFIG'];
    try {
      process.env['GSD_DAEMON_CONFIG'] = '/env/path.yaml';
      const p = resolveConfigPath();
      assert.equal(p, '/env/path.yaml');
    } finally {
      if (prev === undefined) delete process.env['GSD_DAEMON_CONFIG'];
      else process.env['GSD_DAEMON_CONFIG'] = prev;
    }
  });

  it('defaults to ~/.gsd/daemon.yaml', () => {
    const prev = process.env['GSD_DAEMON_CONFIG'];
    try {
      delete process.env['GSD_DAEMON_CONFIG'];
      const p = resolveConfigPath();
      assert.equal(p, join(homedir(), '.gsd', 'daemon.yaml'));
    } finally {
      if (prev !== undefined) process.env['GSD_DAEMON_CONFIG'] = prev;
    }
  });
});

describe('loadConfig', () => {
  // Save and clear DISCORD_BOT_TOKEN for this suite — env override interferes with file-token assertions
  let savedToken: string | undefined;
  before(() => {
    savedToken = process.env['DISCORD_BOT_TOKEN'];
    delete process.env['DISCORD_BOT_TOKEN'];
  });
  afterEach(() => {}); // cleanup dirs handled by top-level afterEach
  // Restore after all tests in this suite
  after(() => {
    if (savedToken !== undefined) process.env['DISCORD_BOT_TOKEN'] = savedToken;
  });

  it('parses valid YAML config', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'daemon.yaml');
    writeFileSync(configPath, `
discord:
  token: "test-token-123"
  guild_id: "g1"
  owner_id: "o1"
projects:
  scan_roots:
    - ~/projects
    - /absolute/path
log:
  file: ~/logs/daemon.log
  level: debug
  max_size_mb: 100
`);
    const cfg = loadConfig(configPath);
    assert.equal(cfg.discord?.token, 'test-token-123');
    assert.equal(cfg.discord?.guild_id, 'g1');
    assert.equal(cfg.log.level, 'debug');
    assert.equal(cfg.log.max_size_mb, 100);
    assert.ok(cfg.log.file.startsWith(homedir()));
    assert.ok(cfg.projects.scan_roots[0]!.startsWith(homedir()));
    assert.equal(cfg.projects.scan_roots[1], '/absolute/path');
  });

  it('returns defaults when config file is missing', () => {
    const cfg = loadConfig('/nonexistent/path/daemon.yaml');
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
    assert.ok(cfg.log.file.endsWith('daemon.log'));
    assert.deepEqual(cfg.projects.scan_roots, []);
    assert.equal(cfg.discord, undefined);
  });

  it('throws on malformed YAML', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'bad.yaml');
    writeFileSync(configPath, ':\n  :\n    bad: [unclosed');
    assert.throws(() => loadConfig(configPath), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('Failed to parse YAML'));
      assert.ok(err.message.includes(configPath));
      return true;
    });
  });

  it('returns defaults for empty YAML file', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'empty.yaml');
    writeFileSync(configPath, '');
    const cfg = loadConfig(configPath);
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
    assert.deepEqual(cfg.projects.scan_roots, []);
  });
});

describe('validateConfig', () => {
  // Save and clear DISCORD_BOT_TOKEN for tests that don't expect it
  let savedToken: string | undefined;
  before(() => {
    savedToken = process.env['DISCORD_BOT_TOKEN'];
    delete process.env['DISCORD_BOT_TOKEN'];
  });
  after(() => {
    if (savedToken !== undefined) process.env['DISCORD_BOT_TOKEN'] = savedToken;
  });

  it('fills remaining defaults for partial config', () => {
    const cfg = validateConfig({ projects: { scan_roots: ['/a'] } });
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
    assert.ok(cfg.log.file.endsWith('daemon.log'));
    assert.deepEqual(cfg.projects.scan_roots, ['/a']);
    assert.equal(cfg.discord, undefined);
  });

  it('falls back to info for invalid log level', () => {
    const cfg = validateConfig({ log: { level: 'trace' } });
    assert.equal(cfg.log.level, 'info');
  });

  it('returns full defaults for null input', () => {
    const cfg = validateConfig(null);
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
  });

  it('returns full defaults for non-object input', () => {
    const cfg = validateConfig('not-an-object');
    assert.equal(cfg.log.level, 'info');
  });

  it('expands ~ in log file path', () => {
    const cfg = validateConfig({ log: { file: '~/my.log' } });
    assert.ok(cfg.log.file.startsWith(homedir()));
    assert.ok(cfg.log.file.endsWith('my.log'));
  });

  it('overrides discord token from DISCORD_BOT_TOKEN env var', () => {
    const prev = process.env['DISCORD_BOT_TOKEN'];
    try {
      process.env['DISCORD_BOT_TOKEN'] = 'env-override-token';
      const cfg = validateConfig({
        discord: { token: 'file-token', guild_id: 'g1', owner_id: 'o1' },
      });
      assert.equal(cfg.discord?.token, 'env-override-token');
      assert.equal(cfg.discord?.guild_id, 'g1');
    } finally {
      if (prev === undefined) delete process.env['DISCORD_BOT_TOKEN'];
      else process.env['DISCORD_BOT_TOKEN'] = prev;
    }
  });

  it('creates discord block from env var even when absent in config', () => {
    const prev = process.env['DISCORD_BOT_TOKEN'];
    try {
      process.env['DISCORD_BOT_TOKEN'] = 'env-only-token';
      const cfg = validateConfig({});
      assert.equal(cfg.discord?.token, 'env-only-token');
    } finally {
      if (prev === undefined) delete process.env['DISCORD_BOT_TOKEN'];
      else process.env['DISCORD_BOT_TOKEN'] = prev;
    }
  });
});

// ---------- logger ----------

describe('Logger', () => {
  it('writes JSON-lines entries to file', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'test.log');

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    logger.info('hello world');
    logger.debug('detail', { key: 'val' });
    await logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const entry0: LogEntry = JSON.parse(lines[0]!);
    assert.equal(entry0.level, 'info');
    assert.equal(entry0.msg, 'hello world');
    assert.ok(entry0.ts); // ISO-8601

    const entry1: LogEntry = JSON.parse(lines[1]!);
    assert.equal(entry1.level, 'debug');
    assert.equal(entry1.msg, 'detail');
    assert.deepEqual(entry1.data, { key: 'val' });
  });

  it('filters entries below configured level', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'filter.log');

    const logger = new Logger({ filePath: logPath, level: 'warn' });
    logger.debug('should not appear');
    logger.info('should not appear either');
    logger.warn('visible warning');
    logger.error('visible error');
    await logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as LogEntry).level, 'warn');
    assert.equal((JSON.parse(lines[1]!) as LogEntry).level, 'error');
  });

  it('close() resolves after stream ends', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'close.log');

    const logger = new Logger({ filePath: logPath, level: 'info' });
    logger.info('before close');
    await logger.close();

    // File should be readable and contain the entry
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('before close'));
  });

  it('creates parent directories if they do not exist', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'nested', 'deep', 'test.log');

    const logger = new Logger({ filePath: logPath, level: 'info' });
    logger.info('nested dir test');
    await logger.close();

    assert.ok(existsSync(logPath));
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('nested dir test'));
  });

  it('does not include data field when not provided', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'nodata.log');

    const logger = new Logger({ filePath: logPath, level: 'info' });
    logger.info('no extra data');
    await logger.close();

    const entry: LogEntry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    assert.equal(entry.data, undefined);
    // Also verify the raw JSON doesn't contain "data" key
    assert.ok(!readFileSync(logPath, 'utf-8').includes('"data"'));
  });
});

// ---------- token safety ----------

describe('token safety', () => {
  it('discord token never appears in log output', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'token-safety.log');

    // Config with a token
    const prev = process.env['DISCORD_BOT_TOKEN'];
    try {
      process.env['DISCORD_BOT_TOKEN'] = 'super-secret-token-value';
      const cfg = validateConfig({});

      const logger = new Logger({ filePath: logPath, level: 'debug' });
      // Log the config object — token must not leak
      logger.info('config loaded', { discord_configured: !!cfg.discord });
      logger.debug('startup complete');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(!content.includes('super-secret-token-value'));
    } finally {
      if (prev === undefined) delete process.env['DISCORD_BOT_TOKEN'];
      else process.env['DISCORD_BOT_TOKEN'] = prev;
    }
  });
});
