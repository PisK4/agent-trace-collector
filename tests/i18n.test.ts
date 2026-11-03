import { describe, expect, test } from 'bun:test';
import { currentLocale, htmlLang, otherLocale, setLocale, t } from '../web/i18n.js';
import { dict } from '../web/i18n-en.js';

describe('i18n 骨架', () => {
  test('zh 侧 key 即文案,带参数照样填充', () => {
    setLocale('zh');
    expect(t('正文未到')).toBe('正文未到');
    expect(t('已复制{label}', { label: 'Session ID' })).toBe('已复制Session ID');
  });

  test('en 侧查字典,缺 key 回退中文原文', () => {
    setLocale('en');
    expect(t('会话栏')).toBe('Sessions');
    expect(t('还没有这条翻译的文案')).toBe('还没有这条翻译的文案');
  });

  test('en 占位替换与词序差异', () => {
    setLocale('en');
    expect(t('已复制{label}', { label: 'Session ID' })).toBe('Copied Session ID');
  });

  test('字典函数值处理英文单复数,收原始 params', () => {
    setLocale('en');
    expect(t('{n} 条探针记录', { n: 1 })).toBe('1 probe record');
    expect(t('{n} 条探针记录', { n: 3 })).toBe('3 probe records');
    setLocale('zh');
    expect(t('{n} 条探针记录', { n: 3 })).toBe('3 条探针记录');
  });

  test('语言状态与 html lang', () => {
    setLocale('zh');
    expect(currentLocale()).toBe('zh');
    expect(otherLocale()).toBe('en');
    expect(htmlLang()).toBe('zh-CN');
    setLocale('en');
    expect(otherLocale()).toBe('zh');
    expect(htmlLang()).toBe('en');
    setLocale('zh');
  });

  test('en 字典没有空值', () => {
    for (const [key, value] of Object.entries(dict)) {
      expect(key.length).toBeGreaterThan(0);
      if (typeof value === 'string') expect(value.length).toBeGreaterThan(0);
    }
  });
});
