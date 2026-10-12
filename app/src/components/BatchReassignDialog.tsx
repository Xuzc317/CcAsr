import { useMemo, useState } from 'react';
import { speakerColor } from '../utils/format';
import type { MergedSegment } from '../types';

/**
 * 批量改判对话框（轻量，约 400px 宽）。
 *
 * 「某人的全部发言改归另一人」——整段认错人时的补救手段。
 * 只改**草稿**，点「应用到草稿」后由底部「确认修改」统一提交。
 *
 * 第一版只支持"全部"，后续再加勾选部分句子与按录音筛选。
 */

interface Props {
  segments: MergedSegment[];
  /** 显示名解析（SPEAKER_0 → leader） */
  displayName: (spk: string) => string;
  /** 当前说话人标签列表（按发言数降序） */
  speakers: string[];
  onApply: (from: string, to: string) => void;
  onClose: () => void;
}

/** 取若干条代表性发言做预览 */
function pickPreviews(segs: MergedSegment[], max = 3): MergedSegment[] {
  if (segs.length <= max) return segs;
  const step = Math.floor(segs.length / max);
  const out: MergedSegment[] = [];
  for (let i = 0; i < max; i += 1) out.push(segs[i * step]);
  return out;
}

export default function BatchReassignDialog({
  segments, displayName, speakers, onApply, onClose,
}: Props) {
  const [from, setFrom] = useState(speakers[0] ?? '');
  const [to, setTo] = useState(speakers[1] ?? speakers[0] ?? '');

  const affected = useMemo(
    () => segments.filter((s) => s.speaker === from),
    [segments, from],
  );

  const noop = from === to || !from || !to || affected.length === 0;

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={S.title}>批量改判说话人</span>
          <button style={S.close} onClick={onClose} title="关闭">✕</button>
        </div>

        <div style={S.body}>
          <div style={S.row}>
            <span style={S.label}>原说话人</span>
            <select
              style={S.select}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              {speakers.map((spk) => (
                <option key={spk} value={spk}>
                  {displayName(spk)}（{spk}）
                </option>
              ))}
            </select>
          </div>

          <div style={S.row}>
            <span style={S.label}>改归</span>
            <select
              style={S.select}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              {speakers.map((spk) => (
                <option key={spk} value={spk}>
                  {displayName(spk)}（{spk}）
                </option>
              ))}
            </select>
          </div>

          <div style={S.scopeRow}>
            <span style={S.label}>影响范围</span>
            {noop ? (
              <span style={S.scopeWarn}>
                {from === to ? '原说话人与改归相同，无法应用'
                  : '该说话人没有发言'}
              </span>
            ) : (
              <span style={S.scope}>
                全部 <b>{affected.length}</b> 段发言
              </span>
            )}
          </div>

          {affected.length > 0 && (
            <div style={S.previewBox}>
              <div style={S.previewHead}>预览</div>
              {pickPreviews(affected).map((s) => (
                <div key={s.id} style={S.previewRow}>
                  <span style={{
                    ...S.previewSpk,
                    background: speakerColor(from),
                  }}>
                    {displayName(from)}
                  </span>
                  <span style={S.previewArrow}>→</span>
                  <span style={{
                    ...S.previewSpk,
                    background: speakerColor(to),
                  }}>
                    {displayName(to)}
                  </span>
                  <span style={S.previewText}>{s.text}</span>
                </div>
              ))}
            </div>
          )}

          <div style={S.note}>
            只改<b>草稿</b>，点底部「确认修改」才写回；应用后可再点「撤销本次批量操作」。
          </div>
        </div>

        <div style={S.foot}>
          <button className="btn btn-secondary" style={S.btn} onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            style={S.btn}
            disabled={noop}
            onClick={() => { onApply(from, to); onClose(); }}
          >
            应用到草稿
          </button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(20,22,40,.35)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    width: 400, maxWidth: '92vw', background: '#fff', borderRadius: 12,
    boxShadow: '0 12px 40px rgba(0,0,0,.18)', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '13px 16px', borderBottom: '1px solid #eee',
  },
  title: { fontSize: 14.5, fontWeight: 700, color: '#2b2b38' },
  close: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    fontSize: 14, color: '#aaa', padding: '2px 5px',
  },
  body: { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 10 },
  scopeRow: { display: 'flex', alignItems: 'center', gap: 10 },
  label: { fontSize: 12.5, color: '#777', width: 62, flexShrink: 0 },
  select: {
    flex: 1, fontSize: 13, padding: '5px 8px',
    border: '1px solid #ddd', borderRadius: 8, background: '#fff',
    color: '#2b2b38', outline: 'none',
  },
  scope: { fontSize: 13, color: '#2b2b38' },
  scopeWarn: { fontSize: 12.5, color: '#c0392b' },
  previewBox: {
    background: '#fafbfc', border: '1px solid #eee', borderRadius: 8,
    padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 7,
  },
  previewHead: { fontSize: 11.5, color: '#999', fontWeight: 600 },
  previewRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  previewSpk: {
    fontSize: 10.5, color: '#fff', fontWeight: 600, padding: '1px 6px',
    borderRadius: 4, flexShrink: 0, maxWidth: 68, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  previewArrow: { fontSize: 11, color: '#bbb', flexShrink: 0 },
  previewText: {
    fontSize: 12, color: '#555', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
  },
  note: { fontSize: 11.5, color: '#999', lineHeight: 1.6 },
  foot: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '12px 16px', borderTop: '1px solid #eee', background: '#fcfcfd',
  },
  btn: { padding: '6px 16px', fontSize: 13, borderRadius: 8 },
};
