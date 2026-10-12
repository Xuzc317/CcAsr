import type { ReactNode } from 'react';
import Logo from './Logo';
import type { SpeakerColorMap } from '../utils/format';
import { pickSpeakerColor } from '../utils/format';

/* ────────────────────────────────────────────────────────────
   共享 UI 原子 —— UI 2.0 组件库
   按钮直接用 global.css 的 .btn / .btn-primary / .btn-secondary …，
   这里只封装带状态的复合件：徽标、说话人标签、证据徽章、空状态、进度。
   ──────────────────────────────────────────────────────────── */

export type BadgeTone = 'ok' | 'run' | 'warn' | 'err' | 'mut' | 'info';

/** 状态徽标（5 态统一，全站复用） */
export function Badge({
  tone = 'mut', dot = false, children, title,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge b-${tone}`} title={title}>
      {dot && <i />}
      {children}
    </span>
  );
}

/** 后端 TaskState 的展示文案与徽标语义见 utils/format.ts 的 taskLabel / taskTone */

/**
 * 说话人标签。
 *
 * 颜色只表达身份且跨页面恒定 —— 传入页面层构建的 colorMap，
 * 保证转录行、纪要分栏、批量改判预览里同一个人永远同色。
 * 点击（传了 onRename 时）用于改判「这一句是谁说的」。
 */
export function SpeakerTag({
  speaker,
  name,
  colorMap,
  small = false,
  onClick,
  title,
}: {
  speaker: string;
  name?: string;
  colorMap?: SpeakerColorMap;
  small?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const label = name || speaker;
  const content = (
    <>
      <i style={{ background: pickSpeakerColor(speaker, colorMap) }} />
      <span className="spk-name">{label}</span>
    </>
  );
  const cls = `spk${small ? ' spk-sm' : ''}`;

  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}
              title={title ?? `${label}（${speaker}）`}>
        {content}
      </button>
    );
  }
  return (
    <span className={cls} title={title ?? `${label}（${speaker}）`}>{content}</span>
  );
}

/** 证据徽章：纪要里的原声时间戳，点击跳到对应音频位置 */
export function EvidenceChip({
  label, title, onClick,
}: {
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="evi" title={title ?? '跳到原声'} onClick={onClick}>
      ▶ {label}
    </button>
  );
}

/** 空状态：图标 + 说明 + 可选操作入口 */
export function EmptyState({
  icon, title, hint, actions, animatedLogo = false,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  /** 用品牌标记 + 声波动画代替 emoji（加载/等待类空态） */
  animatedLogo?: boolean;
}) {
  return (
    <div className="empty">
      {animatedLogo && <Logo size={44} animated />}
      {!animatedLogo && icon && <div style={{ fontSize: 30, lineHeight: 1 }}>{icon}</div>}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

/** 提示条（错误 / 警告 / 信息） */
export function Banner({
  tone, children, right,
}: {
  tone: 'err' | 'warn' | 'info';
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'err' ? 'alert' : undefined}>
      <span>{children}</span>
      {right && <span className="banner-right">{right}</span>}
    </div>
  );
}

/** 细进度条（转录 / 纪要生成） */
export function Progress({
  value, label,
}: {
  /** 0–100 */
  value: number;
  label?: ReactNode;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="busy-bar">
      <div className="track"
           role="progressbar"
           aria-valuenow={pct}
           aria-valuemin={0}
           aria-valuemax={100}>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      {label && <div className="note">{label}</div>}
    </div>
  );
}
