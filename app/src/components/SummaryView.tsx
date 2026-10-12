import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { renderInline, speakerColorAt } from '../utils/format';
import type { SpeakerColorMap } from '../utils/format';
import type { SummaryBlock, StructuredSummary } from '../types';
import { EvidenceChip } from './ui';

/**
 * 会议纪要渲染器。
 *
 * 参考腾讯会议「元宝纪要」的固定版式组件（调研见 docs/yuanbao-meeting-summary-research.md）：
 * 分栏色块 / 三线表格 / 垂直时间轴 / 流程条 / 待办表格。
 * 结构化数据由后端内嵌在 Markdown 注释中，解析失败时由调用方降级为 Markdown。
 *
 * 证据链：block 可携带 `source_refs`（指向转录片段），渲染为可点击的时间戳，
 * 点击即回调 `onJumpTo(ref)` 跳到对应音频位置播放。
 *
 * UI 2.0 版式调整：证据徽章从章节下方的「证据：」前缀行**上收至标题行内**，
 * 少一层视觉噪音，且与所属标题绑定更紧（见设计稿 5.3）。
 */

interface SourceRef {
  start: number;
  end?: number;
  recording_id?: string;
  recording_index?: number;
  quote?: string;
}

interface Props {
  data: StructuredSummary;
  /** 点击证据时间戳时回调（跳到对应录音位置播放） */
  onJumpTo?: (ref: SourceRef) => void;
  /** 说话人 → 颜色（页面层分配，与转录页同色） */
  speakerColors?: SpeakerColorMap;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 证据时间戳组（渲染进标题行内） */
function EvidenceChips({
  refs, onJumpTo,
}: {
  refs?: SourceRef[];
  onJumpTo?: (ref: SourceRef) => void;
}) {
  if (!refs || refs.length === 0 || !onJumpTo) return null;
  return (
    <span className="evi-group">
      {refs.map((r, i) => (
        <EvidenceChip
          key={i}
          label={fmtClock(r.start)}
          title={r.quote ? `原声：${r.quote}` : '跳到原声'}
          onClick={() => onJumpTo(r)}
        />
      ))}
    </span>
  );
}

/** 章节标题行：标题 + 该章节的原声证据 */
function BlockHead({
  title, refs, onJumpTo,
}: {
  title?: string;
  refs?: SourceRef[];
  onJumpTo?: (ref: SourceRef) => void;
}) {
  const hasRefs = !!refs?.length && !!onJumpTo;
  if (!title && !hasRefs) return null;
  return (
    <h2 className="sum-h">
      {title && <span>{title}</span>}
      <EvidenceChips refs={refs} onJumpTo={onJumpTo} />
    </h2>
  );
}

function ColumnsBlock({
  items,
}: {
  items: { icon?: string; heading: string; points: string[] }[];
}) {
  return (
    <div className="sum-cols">
      {items.map((it, i) => {
        // 分栏用固定序号色（紫/橙/蓝/青/玫红/靛），与说话人调色板同源
        const color = speakerColorAt(i);
        return (
          <div key={i} className={`sum-col c${i % 6}`}>
            <div className="col-head">
              <span className="no" style={{ background: color }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              {it.icon && <span style={{ fontSize: 15 }}>{it.icon}</span>}
              <span className="col-title">{it.heading}</span>
            </div>
            <ul>
              {it.points.map((p, j) => (
                <li key={j} dangerouslySetInnerHTML={{ __html: renderInline(p) }} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="sum-table-wrap">
      <table className="sum-table">
        <thead>
          <tr>
            {headers.map((h, i) => <th key={i}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 ? 'alt' : undefined}>
              {r.map((c, j) => (
                <td key={j} dangerouslySetInnerHTML={{ __html: renderInline(c) }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimelineBlock({ items }: { items: { time: string; text: string }[] }) {
  return (
    <div className="sum-timeline">
      {items.map((it, i) => (
        <div key={i} className="tl-item">
          <div className="tl-left">
            <span className="tl-dot" />
            {i < items.length - 1 && <span className="tl-line" />}
          </div>
          <div className="tl-body">
            {it.time && <span className="tl-time">{it.time}</span>}
            <span className="tl-text"
                  dangerouslySetInnerHTML={{ __html: renderInline(it.text) }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 流程条：编号用品牌靛，避免和分栏的语义色抢注意力 */
function StepsBlock({ items }: { items: { heading: string; text: string }[] }) {
  return (
    <div className="sum-steps">
      {items.map((it, i) => (
        <div key={i} className="sum-step">
          <span className="no" style={{ background: 'var(--brand)' }}>
            {String(i + 1).padStart(2, '0')}
          </span>
          <div>
            {it.heading && <div className="st-title">{it.heading}</div>}
            {it.text && (
              <div className="st-text"
                   dangerouslySetInnerHTML={{ __html: renderInline(it.text) }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BulletsBlock({ points }: { points: string[] }) {
  return (
    <ul className="sum-ul">
      {points.map((p, i) => (
        <li key={i} dangerouslySetInnerHTML={{ __html: renderInline(p) }} />
      ))}
    </ul>
  );
}

function renderBlock(
  b: SummaryBlock,
  i: number,
  onJumpTo?: (ref: SourceRef) => void,
): ReactNode {
  const refs = (b as { source_refs?: SourceRef[] }).source_refs;
  const head = <BlockHead title={b.title} refs={refs} onJumpTo={onJumpTo} />;

  switch (b.type) {
    case 'summary':
      return (
        <section key={i} className="sum-block">
          {head}
          <blockquote className="sum-quote"
                      dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
        </section>
      );
    case 'columns':
      return (
        <section key={i} className="sum-block">
          {head}
          <ColumnsBlock items={b.items} />
        </section>
      );
    case 'table':
      return (
        <section key={i} className="sum-block">
          {head}
          <TableBlock headers={b.headers} rows={b.rows} />
        </section>
      );
    case 'timeline':
      return (
        <section key={i} className="sum-block">
          {head}
          <TimelineBlock items={b.items} />
        </section>
      );
    case 'steps':
      return (
        <section key={i} className="sum-block">
          {head}
          <StepsBlock items={b.items} />
        </section>
      );
    case 'todo':
      return (
        <section key={i} className="sum-block">
          <BlockHead title={b.title || '待办事项'} refs={refs} onJumpTo={onJumpTo} />
          <TableBlock headers={b.headers} rows={b.rows} />
        </section>
      );
    case 'bullets':
      return (
        <section key={i} className="sum-block">
          {head}
          <BulletsBlock points={b.points} />
        </section>
      );
    case 'text':
      return (
        <section key={i} className="sum-block">
          {head}
          <p className="sum-para"
             dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
        </section>
      );
    default:
      return null;
  }
}

export default function SummaryView({ data, onJumpTo, speakerColors }: Props) {
  const todoRows = useMemo(() => {
    for (const b of data.blocks) {
      if (b.type === 'todo' && 'rows' in b) return b.rows.length;
    }
    return 0;
  }, [data]);

  const refCount = useMemo(
    () => data.blocks.reduce(
      (n, b) => n + (((b as { source_refs?: unknown[] }).source_refs?.length) || 0), 0),
    [data],
  );

  /** 参会人 chip 用说话人序号色，和转录页对上号 */
  const attendeeColor = (name: string, i: number) =>
    speakerColors?.[name] ?? speakerColorAt(i);

  return (
    <article className="sum-wrap">
      <header className="sum-head">
        <h1 className="title">{data.title || '会议纪要'}</h1>
        {data.attendees.length > 0 && (
          <div className="attendees">
            <span>👥</span>
            {data.attendees.map((a, i) => (
              <span key={i} className="attendee">
                <i style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: 3,
                  background: attendeeColor(a, i), marginRight: 5,
                  verticalAlign: 'middle',
                }} />
                {a}
              </span>
            ))}
          </div>
        )}
        {data.summary && (
          <div className="overview"
               dangerouslySetInnerHTML={{ __html: renderInline(data.summary) }} />
        )}
      </header>

      <div className="sum-body">
        {data.blocks.map((b, i) => renderBlock(b, i, onJumpTo))}
      </div>

      <div className="sum-foot">
        <span>{todoRows > 0 ? `共 ${todoRows} 项待办` : '无待办事项'}</span>
        <span className="sep" />
        <span>
          {refCount > 0
            ? `已关联 ${refCount} 处原声证据（点 ▶ 可跳转）`
            : '未关联原声证据'}
        </span>
      </div>
    </article>
  );
}
