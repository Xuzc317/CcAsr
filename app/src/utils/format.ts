/**
 * 轻量 Markdown 处理工具。
 *
 * 会议纪要里的要点句式是「**加粗标签**：内容」，只需要支持加粗与转义，
 * 因此不引入完整 Markdown 库，避免 XSS 与打包体积。
 */

/** 转义 HTML 特殊字符 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把 **加粗** 转成 <strong>，其余内容转义；返回可直接 dangerouslySetInnerHTML 的串 */
export function renderInline(s: string): string {
  const escaped = escapeHtml(s || '');
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** 秒 → HH:MM:SS */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** 秒 → 人类可读时长（用于总时长展示） */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/**
 * 说话人识别调色板 —— 6 色恒定（UI 2.0 规范）。
 *
 * 同一个说话人在**转录、纪要、批量改判、录音队列**里始终同色：
 * 颜色只承担「身份识别」，不再兼作状态色（状态色见 global.css 的语义令牌）。
 */
export const SPEAKER_PALETTE = [
  '#4F46E5', // 靛
  '#0D9488', // 青
  '#D97706', // 琥珀
  '#E11D48', // 玫红
  '#0284C7', // 天蓝
  '#7C3AED', // 紫
];

/** 出现人数超过调色板长度时循环取色，保证「同人同色」永不失效 */
export function speakerColorAt(index: number): string {
  return SPEAKER_PALETTE[index % SPEAKER_PALETTE.length];
}

/**
 * 由 ID 推导颜色（无需上下文时的兜底）。
 *
 * 优先解析 `SPEAKER_3` 这类后端 ID 里的序号，让同一场会议里
 * SPEAKER_0/1/2 天然拿到相邻且不同的颜色；非标准 ID（用户改判成
 * 自定义名）再走稳定哈希。哈希与序号可能撞色，所以需要**绝对互异**的
 * 场景请用 `buildSpeakerColorMap` 显式指定序号。
 */
export function speakerColor(speaker: string): string {
  if (!speaker) return SPEAKER_PALETTE[0];
  const m = /(\d+)\s*$/.exec(speaker);
  if (m) return speakerColorAt(Number(m[1]));
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
  }
  return speakerColorAt(hash);
}

/** 说话人 → 颜色（由页面层构建一次，向下传递给所有子视图） */
export type SpeakerColorMap = Record<string, string>;

/**
 * 按「出现顺序」给一场会议里的所有说话人分配互不重复的颜色。
 *
 * 用序号分配而不是逐个哈希，是为了保证同一页里 N 个说话人两两不同色 ——
 * 哈希在 6 色盘上约 40% 概率撞色，会让纪要分栏与说话人标签失去区分度。
 */
export function buildSpeakerColorMap(speakers: string[]): SpeakerColorMap {
  const map: SpeakerColorMap = {};
  let next = 0;
  for (const spk of speakers) {
    if (!spk || map[spk]) continue;
    map[spk] = speakerColorAt(next);
    next += 1;
  }
  return map;
}

/** 取色：优先用页面层分配的序号色，缺失才回退到 ID 推导 */
export function pickSpeakerColor(
  speaker: string, map?: SpeakerColorMap,
): string {
  return (map && map[speaker]) || speakerColor(speaker);
}

/**
 * 后端 TaskState（pending / processing / completed / failed）
 * → 统一徽标文案与语义。
 * 徽标样式类由 global.css 的 .b-ok / .b-run / .b-warn / .b-err / .b-mut 提供。
 */
export type TaskTone = 'ok' | 'run' | 'warn' | 'err' | 'mut';

export function taskTone(state: string): TaskTone {
  switch (state) {
    case 'completed': return 'ok';
    case 'failed': return 'err';
    case 'processing': return 'run';
    default: return 'mut';
  }
}

export function taskLabel(state: string): string {
  return ({
    pending: '排队中', processing: '转录中', completed: '完成', failed: '失败',
  } as Record<string, string>)[state] || state;
}
