import { homedir } from 'node:os';
import type { Config } from './config';

/**
 * 启动横幅：把 `web/tracery-dark.svg` 的线描蜘蛛转成半块字符画，右侧接定位信息。
 *
 * 字符画由 logo 光栅化后按墨迹包围盒降采样得到，不是另画一个图形：改 logo 就要重出这一份。
 */
const MARK = [
  '                  ▄████',
  '                ▄███▀▀▀',
  '              ▄████    ▄████',
  '        ▄▄█████████  ▄████▀',
  '  ▄  ▄███████████████████',
  '██████████▀▀█████  ▀████',
  '▀█████████   ████▄▄▄████',
  '   ███████▄▄▄███████████',
  '▄███████████████▀▀██████▄▄▄',
  '██████████████    ██████████▄',
  '▀  ▄█████████████████   ▀▀████',
  '▄█████▀▀███████████████▄▄  ██▀',
  '████  ▄████▀▀      ▀█████▄',
  '██▀  █████           ▀████',
];

/** 右侧文字的起始行，让文字落在图形中部而不是顶部。 */
const TEXT_ROW = 4;
const GAP = 3;
const AMBER = '\u001b[38;2;253;206;151m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

function shorten(dir: string): string {
  const home = homedir();
  return dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir;
}

export function startupBanner(config: Config, color: boolean): string {
  const paint = (text: string, tone: string) => (color ? tone + text + RESET : text);
  const right = [
    paint('Tracery', AMBER),
    `http://127.0.0.1:${config.port}`,
    paint(shorten(config.dataDir), DIM),
  ];
  const width = Math.max(...MARK.map((row) => row.length)) + GAP;
  const rows = MARK.map((row, index) => {
    const label = right[index - TEXT_ROW];
    return label === undefined ? row : row.padEnd(width) + label;
  });
  return rows.join('\n') + '\n';
}
