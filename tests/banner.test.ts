import { test, expect } from 'bun:test';
import { loadConfig } from '../src/config';
import { startupBanner } from '../src/banner';

test('横幅带定位信息，数据目录以家目录缩写呈现', () => {
  const config = { ...loadConfig({}), port: 8320, dataDir: `${process.env.HOME}/tmp/tracery` };
  const text = startupBanner(config, false);
  expect(text).toContain('Tracery');
  expect(text).toContain('http://127.0.0.1:8320');
  expect(text).toContain('~/tmp/tracery');
  expect(text).not.toContain('\u001b[');
});

test('只有显式要颜色时才带转义序列', () => {
  const config = { ...loadConfig({}), port: 8320 };
  expect(startupBanner(config, true)).toContain('\u001b[');
});
