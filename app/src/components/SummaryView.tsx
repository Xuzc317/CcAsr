import { useMemo } from 'react';
import { renderInline, speakerColor } from '../utils/format';
import type { SummaryBlock, StructuredSummary } from '../types';

/**
 * 会议纪要渲染器。
 *
 * 参考腾讯会议「元宝纪要」的固定版式组件（调研见 docs/yuanbao-meeting-summary-research.md）：
 * 分栏色块 / 三线表格 / 垂直时间轴 / 流程条 / 待办表格。
 * 结构化数据由后端内嵌在 Markdown 注释中，解析失败时由调用方降级为 Markdown。
 */

function BlockTitle({ children }: { children?: string }) {
  if (!children) return null;
  return <h3 style={S.blockTitle}>{children}</h3>;
}

function ColumnsBlock({ items }: { items: SummaryBlock extends { items: infer I } ? I : never }) {
  const list = items as { icon?: string; heading: string; points: string[] }[];
  return (
    <div style={S.columnsGrid}>
      {list.map((it, i) => {
        // 每个分栏独立主题色（元宝观感特征）
        const color = speakerColor(`col-${i}`);
        return (
          <div key={i} style={{ ...S.colCard, borderTop: `3px solid ${color}` }}>
            <div style={S.colHead}>
              <span style={S.colBadge(color)}>{String(i + 1).padStart(2, '0')}</span>
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
            <span style={S.stepNum(color)}>{String(i + 1).padStart(2, '0')}</span>
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

function renderBlock(b: SummaryBlock, i: number) {
  switch (b.type) {
    case 'summary':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <blockquote style={S.quote}
                      dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
        </div>
      );
    case 'columns':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <ColumnsBlock items={b.items as never} />
        </div>
      );
    case 'table':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <TableBlock headers={b.headers} rows={b.rows} />
        </div>
      );
    case 'timeline':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <TimelineBlock items={b.items} />
        </div>
      );
    case 'steps':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <StepsBlock items={b.items} />
        </div>
      );
    case 'todo':
      return (
        <div key={i}>
          <BlockTitle>{b.title || '待办事项'}</BlockTitle>
          <TableBlock headers={b.headers} rows={b.rows} />
        </div>
      );
    case 'bullets':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <BulletsBlock points={b.points} />
        </div>
      );
    case 'text':
      return (
        <div key={i}>
          <BlockTitle>{b.title}</BlockTitle>
          <p style={S.para}
             dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
        </div>
      );
    default:
      return null;
  }
}

export default function SummaryView({ data }: { data: StructuredSummary }) {
  const todoCount = useMemo(
    () => data.blocks.find((b) => b.type === 'todo' && 'rows' in b)
      ? (data.blocks.find((b) => b.type === 'todo' && 'rows' in b) as
          { rows: string[][] }).rows.length
      : 0,
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
        {data.blocks.map((b, i) => renderBlock(b, i))}
      </div>

      {todoCount > 0 && (
        <div style={S.footerNote}>共 {todoCount} 项待办</div>
      )}
    </article>
  );
}

const S: Record<string, any> = {
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
  colBadge: (color: string) => ({
    background: color, color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '1px 7px', borderRadius: 4,
  }),
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
  stepNum: (color: string) => ({
    background: color, color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '2px 6px', borderRadius: 4, height: 'fit-content', flexShrink: 0,
  }),
  stepHeading: { fontSize: 13.5, fontWeight: 700, color: '#1a1a2e', marginBottom: 3 },
  stepText: { fontSize: 13, lineHeight: 1.7, color: '#555' },
  footerNote: {
    marginTop: 26, paddingTop: 12, borderTop: '1px solid #eee',
    fontSize: 12, color: '#999', textAlign: 'center',
  },
};
