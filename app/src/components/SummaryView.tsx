import { useMemo } from 'react';
import { renderInline, speakerColor } from '../utils/format';
import type { SummaryBlock, StructuredSummary } from '../types';

/**
 * 会议纪要渲染器。
 *
 * 参考腾讯会议「元宝纪要」的固定版式组件（调研见 docs/yuanbao-meeting-summary-research.md）：
 * 分栏色块 / 三线表格 / 垂直时间轴 / 流程条 / 待办表格。
 * 结构化数据由后端内嵌在 Markdown 注释中，解析失败时由调用方降级为 Markdown。
 *
 * 证据链：block 可携带 `source_refs`（指向转录片段），渲染为可点击的时间戳，
 * 点击即回调 `onJumpTo(ref)` 跳到对应音频位置播放。
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
}

function BlockTitle({ children }: { children?: string }) {
  if (!children) return null;
  return <h3 style={S.blockTitle}>{children}</h3>;
}

/** 证据时间戳（点击跳转到原声） */
function EvidenceRefs({
  refs, onJumpTo,
}: {
  refs?: SourceRef[];
  onJumpTo?: (ref: SourceRef) => void;
}) {
  if (!refs || refs.length === 0 || !onJumpTo) return null;
  const fmt = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  };
  return (
    <div style={S.evidenceRow}>
      <span style={S.evidenceLabel}>证据</span>
      {refs.map((r, i) => (
        <button
          key={i}
          style={S.evidenceChip}
          title={r.quote ? `原声：${r.quote}` : '跳到原声'}
          onClick={() => onJumpTo(r)}
        >
          ▶ {fmt(r.start)}
        </button>
      ))}
    </div>
  );
}

function ColumnsBlock({
  items, refs, onJumpTo,
}: {
  items: { icon?: string; heading: string; points: string[] }[];
  refs?: SourceRef[];
  onJumpTo?: (ref: SourceRef) => void;
}) {
  return (
    <>
      <div style={S.columnsGrid}>
        {items.map((it, i) => {
          const color = speakerColor(`col-${i}`);
          return (
            <div key={i} style={{ ...S.colCard, borderTop: `3px solid ${color}` }}>
              <div style={S.colHead}>
                <span style={SF.colBadge(color)}>{String(i + 1).padStart(2, '0')}</span>
                {it.icon && <span style={{ fontSize: 16 }}>{it.icon}</span>}
                <span style={S.colHeading}>{it.heading}</span>
              </div>
              <ul style={S.ul}>
                {it.points.map((p, j) => (
                  <li key={j} style={S.li}
                      dangerouslySetInnerHTML={{ __html: renderInline(p) }} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
    </>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div style={S.tableWrap}>
      <table style={S.table}>
        <thead>
          <tr>
            {headers.map((h, i) => <th key={i} style={S.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={i % 2 ? S.trAlt : undefined}>
              {r.map((c, j) => (
                <td key={j} style={S.td}
                    dangerouslySetInnerHTML={{ __html: renderInline(c) }} />
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
    <div style={S.timeline}>
      {items.map((it, i) => (
        <div key={i} style={S.tlItem}>
          <div style={S.tlLeft}>
            <span style={S.tlDot} />
            {i < items.length - 1 && <span style={S.tlLine} />}
          </div>
          <div style={S.tlBody}>
            {it.time && <span style={S.tlTime}>{it.time}</span>}
            <span style={S.tlText}
                  dangerouslySetInnerHTML={{ __html: renderInline(it.text) }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StepsBlock({ items }: { items: { heading: string; text: string }[] }) {
  return (
    <div style={S.stepsGrid}>
      {items.map((it, i) => {
        const color = speakerColor(`step-${i}`);
        return (
          <div key={i} style={{ ...S.stepCard, borderLeft: `3px solid ${color}` }}>
            <span style={SF.stepNum(color)}>{String(i + 1).padStart(2, '0')}</span>
            <div>
              {it.heading && <div style={S.stepHeading}>{it.heading}</div>}
              {it.text && (
                <div style={S.stepText}
                     dangerouslySetInnerHTML={{ __html: renderInline(it.text) }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BulletsBlock({ points }: { points: string[] }) {
  return (
    <ul style={S.ul}>
      {points.map((p, i) => (
        <li key={i} style={S.li}
            dangerouslySetInnerHTML={{ __html: renderInline(p) }} />
      ))}
    </ul>
  );
}

function renderBlock(
  b: SummaryBlock,
  i: number,
  onJumpTo?: (ref: SourceRef) => void,
) {
  const refs = (b as { source_refs?: SourceRef[] }).source_refs;
  switch (b.type) {
    case 'summary':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <blockquote style={S.quote}
                      dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'columns':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <ColumnsBlock items={b.items} refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'table':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <TableBlock headers={b.headers} rows={b.rows} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'timeline':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <TimelineBlock items={b.items} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'steps':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <StepsBlock items={b.items} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'todo':
      return (
        <div key={i}>
          <BlockTitle>{b.title || '待办事项'}</BlockTitle>
          <TableBlock headers={b.headers} rows={b.rows} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'bullets':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <BulletsBlock points={b.points} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    case 'text':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <p style={S.para}
             dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
          <EvidenceRefs refs={refs} onJumpTo={onJumpTo} />
        </div>
      );
    default:
      return null;
  }
}

export default function SummaryView({ data, onJumpTo }: Props) {
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

  return (
    <article style={S.wrap}>
      <header style={S.header}>
        <h1 style={S.title}>{data.title || '会议纪要'}</h1>
        {data.attendees.length > 0 && (
          <div style={S.attendees}>
            <span style={{ marginRight: 6 }}>👥</span>
            {data.attendees.map((a, i) => (
              <span key={i} style={S.attendeeChip}>{a}</span>
            ))}
          </div>
        )}
        {data.summary && (
          <div style={S.summaryBox}
               dangerouslySetInnerHTML={{ __html: renderInline(data.summary) }} />
        )}
      </header>

      <div style={S.body}>
        {data.blocks.map((b, i) => renderBlock(b, i, onJumpTo))}
      </div>

      <div style={S.footerNote}>
        <span style={S.footerItem}>
          {todoRows > 0 ? `共 ${todoRows} 项待办` : '无待办事项'}
        </span>
        <span style={S.footerSep} />
        <span style={S.footerItem}>
          {refCount > 0
            ? `已关联 ${refCount} 处原声证据（点 ▶ 可跳转）`
            : '未关联原声证据'}
        </span>
      </div>
    </article>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 900, margin: '0 auto', color: '#1a1a2e' },
  header: { marginBottom: 24 },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 10, lineHeight: 1.4 },
  attendees: {
    display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
    fontSize: 13, color: '#666', marginBottom: 12,
  },
  attendeeChip: {
    background: '#eef0ff', color: '#4361ee', padding: '2px 10px',
    borderRadius: 12, fontSize: 12, fontWeight: 600,
  },
  summaryBox: {
    borderLeft: '3px solid #4361ee', background: '#f7f8fc',
    padding: '12px 16px', borderRadius: '0 8px 8px 0',
    fontSize: 14, lineHeight: 1.8, color: '#333',
  },
  body: { display: 'flex', flexDirection: 'column', gap: 22 },
  blockTitle: {
    fontSize: 16, fontWeight: 700, marginBottom: 10, color: '#1a1a2e',
    paddingBottom: 6, borderBottom: '1px solid #eee',
  },
  quote: {
    borderLeft: '3px solid #ddd', paddingLeft: 14, color: '#555',
    fontSize: 14, lineHeight: 1.8, margin: 0,
  },
  columnsGrid: {
    display: 'grid', gap: 12,
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  },
  colCard: {
    background: '#fafbff', border: '1px solid #ececf5', borderRadius: 8,
    padding: '12px 14px',
  },
  colHead: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 },
  colHeading: { fontSize: 14, fontWeight: 700, color: '#1a1a2e' },
  ul: { margin: 0, paddingLeft: 18 },
  li: { fontSize: 13.5, lineHeight: 1.85, color: '#333', marginBottom: 5 },
  para: { fontSize: 14, lineHeight: 1.9, color: '#333', margin: 0 },
  tableWrap: { overflowX: 'auto' },
  table: {
    width: '100%', borderCollapse: 'collapse', fontSize: 13.5,
    borderTop: '2px solid #333', borderBottom: '2px solid #333',
  },
  th: {
    textAlign: 'left', padding: '9px 12px', fontWeight: 700,
    color: '#1a1a2e', borderBottom: '1px solid #333', whiteSpace: 'nowrap',
  },
  td: { padding: '9px 12px', color: '#333', borderBottom: '1px solid #eee' },
  trAlt: { background: '#fafafa' },
  timeline: { display: 'flex', flexDirection: 'column' },
  tlItem: { display: 'flex', gap: 12 },
  tlLeft: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14 },
  tlDot: {
    width: 10, height: 10, borderRadius: '50%', background: '#4361ee',
    marginTop: 5, flexShrink: 0,
  },
  tlLine: { flex: 1, width: 2, background: '#e0e0ee', minHeight: 14 },
  tlBody: { paddingBottom: 14, flex: 1 },
  tlTime: {
    display: 'inline-block', fontSize: 12, fontWeight: 700, color: '#4361ee',
    marginRight: 8, fontVariantNumeric: 'tabular-nums',
  },
  tlText: { fontSize: 13.5, lineHeight: 1.8, color: '#333' },
  stepsGrid: {
    display: 'grid', gap: 10,
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  },
  stepCard: {
    display: 'flex', gap: 10, background: '#fafbff',
    border: '1px solid #ececf5', borderRadius: 8, padding: '11px 13px',
  },
  stepHeading: { fontSize: 13.5, fontWeight: 700, color: '#1a1a2e', marginBottom: 3 },
  stepText: { fontSize: 13, lineHeight: 1.7, color: '#555' },
  evidenceRow: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
    marginTop: 8,
  },
  evidenceLabel: { fontSize: 11, color: '#aaa', fontWeight: 600 },
  evidenceChip: {
    border: '1px solid #d8dcf0', background: '#f4f6ff', color: '#4361ee',
    fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
    cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
  },
  footerNote: {
    marginTop: 26, paddingTop: 12, borderTop: '1px solid #eee',
    fontSize: 12, color: '#999', display: 'flex', justifyContent: 'center',
    alignItems: 'center', gap: 10, flexWrap: 'wrap',
  },
  footerItem: { fontSize: 12, color: '#999' },
  footerSep: {
    width: 1, height: 11, background: '#ddd', display: 'inline-block',
  },
};

/** 依赖主题色的样式：调用后返回 CSSProperties */
const SF: Record<string, (color: string) => React.CSSProperties> = {
  colBadge: (color) => ({
    background: color, color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '1px 7px', borderRadius: 4,
  }),
  stepNum: (color) => ({
    background: color, color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '2px 6px', borderRadius: 4, height: 'fit-content', flexShrink: 0,
  }),
};
