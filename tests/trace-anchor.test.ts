import { expect, test } from 'bun:test';
import { clampRestoreDelta } from '../web/trace-dom.js';

// 会话头在首次提交后变高时，补偿不能把锚点推进吸顶遮挡区：1 号组要停在
// 新头底，而不是被头部盖住。实测数字来自会话 a58b0a51（头 135px → 205px）。
test('头部变高时，向下补偿停在吸顶遮挡区下沿', () => {
  // 锚点原在 187px，提交后掉到 257px；照旧补偿 70px 会把它塞回新头底下面。
  expect(clampRestoreDelta(70, 257, 257)).toBe(0);
  // 部分遮挡：锚点原在 200px，提交后 270px；只能补到吸顶下沿。
  expect(clampRestoreDelta(70, 270, 257)).toBe(13);
  // 锚点已在遮挡区里：不向下补。
  expect(clampRestoreDelta(30, 200, 257)).toBe(0);
});

test('中段阅读的补偿不受吸顶下沿影响', () => {
  // 倒着读别处时，锚点在遮挡区下面，补偿量原样保留。
  expect(clampRestoreDelta(70, 470, 257)).toBe(70);
  // 头部变矮或内容收缩：向上补偿不夹取。
  expect(clampRestoreDelta(-40, 260, 257)).toBe(-40);
});
