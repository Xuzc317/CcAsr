import { useMemo, useState } from 'react';
import type { SpeakerColorMap } from '../utils/format';
import type { MergedSegment } from '../types';
import { SpeakerTag } from './ui';

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
  /** 说话人 → 颜色（与转录页、纪要同色） */
  speakerColors?: SpeakerColorMap;
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
  segments, displayName, speakers, speakerColors, onApply, onClose,
}: Props) {
  const [from, setFrom] = useState(speakers[0] ?? '');
  const [to, setTo] = useState(speakers[1] ?? speakers[0] ?? '');

  const affected = useMemo(
    () => segments.filter((s) => s.speaker === from),
    [segments, from],
  );

  const noop = from === to || !from || !to || affected.length === 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="批量改判说话人"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <span className="dialog-title">批量改判说话人</span>
          <button className="x" onClick={onClose} title="关闭" aria-label="关闭">✕</button>
        </div>

        <div className="dialog-body">
          <div className="form-row">
            <span className="label">原说话人</span>
            <select
              className="field field-sm"
              value={from}
              aria-label="原说话人"
              onChange={(e) => setFrom(e.target.value)}
            >
              {speakers.map((spk) => (
                <option key={spk} value={spk}>
                  {displayName(spk)}（{spk}）
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="label">改归</span>
            <select
              className="field field-sm"
              value={to}
              aria-label="改归说话人"
              onChange={(e) => setTo(e.target.value)}
            >
              {speakers.map((spk) => (
                <option key={spk} value={spk}>
                  {displayName(spk)}（{spk}）
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="label">影响范围</span>
            {noop ? (
              <span className="scope-warn">
                {from === to ? '原说话人与改归相同，无法应用' : '该说话人没有发言'}
              </span>
            ) : (
              <span className="scope-ok">全部 <b>{affected.length}</b> 段发言</span>
            )}
          </div>

          {affected.length > 0 && (
            <div className="preview-box">
              <div className="head">预览</div>
              {pickPreviews(affected).map((s) => (
                <div key={s.id} className="preview-row">
                  <SpeakerTag
                    small
                    speaker={from}
                    name={displayName(from)}
                    colorMap={speakerColors}
                  />
                  <span className="arrow">→</span>
                  <SpeakerTag
                    small
                    speaker={to}
                    name={displayName(to)}
                    colorMap={speakerColors}
                  />
                  <span className="txt" title={s.text}>{s.text}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.6 }}>
            只改<b>草稿</b>，点底部「确认修改」才写回；应用后可再点「撤销本次批量操作」。
          </div>
        </div>

        <div className="dialog-foot">
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary btn-sm"
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
