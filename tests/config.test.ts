import { test, expect } from 'bun:test';
import { defaultDataDir } from '../src/config';

test('默认数据目录按平台惯例选根', () => {
  expect(defaultDataDir({}, 'darwin', '/home/u')).toBe('/home/u/Library/Application Support/tracery');
  expect(defaultDataDir({}, 'linux', '/home/u')).toBe('/home/u/.local/share/tracery');
  expect(defaultDataDir({}, 'freebsd', '/home/u')).toBe('/home/u/.local/share/tracery');
});

test('XDG_DATA_HOME 覆盖根目录，目录名不随平台变', () => {
  expect(defaultDataDir({ XDG_DATA_HOME: '/x/data' }, 'linux', '/home/u')).toBe('/x/data/tracery');
  expect(defaultDataDir({ XDG_DATA_HOME: '  ' }, 'linux', '/home/u')).toBe('/home/u/.local/share/tracery');
});