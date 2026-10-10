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

/** 依据说话人 ID 稳定地取一个主题色（参考元宝的独立主题色卡片）*/
const PALETTE = [
  '#4361ee', '#2a9d8f', '#e76f51', '#7209b7',
  '#f4a261', '#118ab2', '#ef476f', '#06d6a0',
];

export function speakerColor(speaker: string): string {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
