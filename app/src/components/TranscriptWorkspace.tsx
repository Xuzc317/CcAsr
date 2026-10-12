import { useMemo, useRef, useState, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import * as api from '../services/api';
import { formatTime, speakerColor } from '../utils/format';
import type { MergedSegment, MergedTranscript } from '../types';
import type { EditAction, EditState } from '../utils/editState';
import { computeChanges, speakerOrder, totalChanges } from '../utils/editState';
import BatchReassignDialog from './BatchReassignDialog';

interface Props {
  projectId: string;
  transcript: MergedTranscript;
  /** 编辑草稿状态（由 MeetingDetailPage 持有，切换 Tab 不丢） */
  edit: EditState;
  dispatch: React.Dispatch<EditAction>;
  /** 保存成功后回调（父级据此刷新纪要等） */
  onSaved?: (saved: MergedTranscript) => void;
  /** 当前高亮的片段（由父级共享播放器驱动，如从纪要证据跳转过来） */
  activeSegId?: string | null;
  /** 请求播放某段录音的某个本地时间点（父级持有唯一的 <audio>） */
  onPlay?: (recordingId: string, localStart: number, segId?: string) => void;
  /** 有未保存修改时点导出，父级弹出「保存并导出」 */
  onExportWithDraft?: (fmt: 'txt' | 'json') => void;
}

/**
 * 合并文档工作区 —— 转录完成后的全部修改都在这里。
 *
 * 三类修改（对应腾讯会议纪要的编辑能力）：
 *   1. **改说话人名**：顶部「说话人」区，SPEAKER_0 → 「leader」，全局生效
 *   2. **改单句归属**：点句首的说话人标签，改判这一句是谁说的
 *   3. **改文字**：双击正文校对
 *   + **批量改判**：工具栏按钮，把某人的全部发言改归另一人
 *
 * 所有修改都写在**父级持有的草稿**里，底部确认栏汇总「待保存 N 处」，
 * 点「确认修改」才写回后端；「撤销全部修改」回到上次保存的状态。
 *
 * 音频播放器由父级 MeetingDetailPage 统一持有（`onPlay`），
 * 使纪要里的「证据」跳转与这里的点击播放共用同一个播放器。
 */
export default function TranscriptWorkspace({
  projectId, transcript, edit, dispatch, onSaved,
  activeSegId, onPlay, onExportWithDraft,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');
  /** 正在改归属的那一段（展开下拉） */
  const [reassignId, setReassignId] = useState<string | null>(null);
  /** 折叠/展开顶部说话人区（段数多时省空间） */
  const [showSpeakerBar, setShowSpeakerBar] = useState(true);
  const [showBatch, setShowBatch] = useState(false);

  const virtuosoRef = useRef<VirtuosoHandle>(null);

  /** 当前出现的说话人标签（按发言数降序） */
  const speakers = useMemo(() => speakerOrder(edit.segments), [edit.segments]);

  const displayName = useCallback(
    (spk: string) => edit.names[spk] || spk,
    [edit.names],
  );

  const changes = useMemo(() => computeChanges(edit), [edit]);
  const total = totalChanges(changes);
  const dirty = total > 0;

  // 性能：行渲染里不能做 O(n) 查找（587 行会变成 587² 次比较）。
  // 预先建索引，渲染时 O(1)。
  const baseTextById = useMemo(() => {
    const m = new Map<string, string>();
    edit.baseline.forEach((s) => m.set(s.id, s.text));
    return m;
  }, [edit.baseline]);

  const speakerCounts = useMemo(() => {
    const m = new Map<string, number>();
    edit.segments.forEach((s) => m.set(s.speaker, (m.get(s.speaker) || 0) + 1));
    return m;
  }, [edit.segments]);

  // ── 播放：交给父级统一持有的播放器 ───────────────────────────
  const playSegment = useCallback((seg: MergedSegment) => {
    if (onPlay) onPlay(seg.recording_id, seg.local_start, seg.id);
  }, [onPlay]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg('');
    setError('');
    try {
      const payload = {
        segments: edit.segments.map((s) => ({
          id: s.id, text: s.text, speaker: s.speaker,
        })),
        speaker_map: edit.names,
        revision: edit.revision,
      };
      const res = await api.saveTranscriptEdits(projectId, payload);
      dispatch({ type: 'saved', transcript: res.transcript });
      const c = res.changes;
      setSaveMsg(c
        ? `已保存 ${c.text + c.speaker + c.renamed} 处`
        : `已保存 ${res.updated} 处`);
      setEditingId(null);
      setReassignId(null);
      onSaved?.(res.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [projectId, edit, dispatch, onSaved]);

  const handleExport = useCallback(async (fmt: 'txt' | 'json') => {
    // 有未保存内容时交给父级弹「保存并导出」，避免导出的是旧内容
    if (dirty && onExportWithDraft) {
      onExportWithDraft(fmt);
      return;
    }
    try {
      const { filename, content } = await api.exportProject(projectId, fmt);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    }
  }, [projectId, dirty, onExportWithDraft]);

  return (
    <div style={S.wrap}>
      {/* ── 顶部工具条 ── */}
      <div style={S.toolbar}>
        <div style={S.toolLeft}>
          <span style={S.stat}>{edit.segments.length} 段</span>
          <span style={S.stat}>·</span>
          <span style={S.stat}>{speakers.length} 位说话人</span>
          <span style={S.stat}>·</span>
          <span style={S.stat}>{formatTime(transcript.duration)}</span>
          <span style={S.recStat}>{transcript.recordings.length} 段录音</span>
        </div>
        <div style={S.toolRight}>
          <button
            className="btn btn-secondary"
            style={S.smallBtn}
            onClick={() => setShowBatch(true)}
            disabled={speakers.length < 2}
            title={speakers.length < 2
              ? '只有一个说话人，无需批量改判'
              : '把某人的全部发言改归另一人'}
          >
            ⇄ 批量改判
          </button>
          <button
            className="btn btn-secondary"
            style={S.smallBtn}
            onClick={() => setShowSpeakerBar((v) => !v)}
          >
            {showSpeakerBar ? '收起说话人' : `说话人 (${speakers.length})`}
          </button>
          <button className="btn btn-secondary" style={S.smallBtn}
                  onClick={() => handleExport('txt')}>
            ⬇ TXT
          </button>
          <button className="btn btn-secondary" style={S.smallBtn}
                  onClick={() => handleExport('json')}>
            ⬇ JSON
          </button>
        </div>
      </div>

      {/* ── 说话人改名 ── */}
      {showSpeakerBar && (
        <div style={S.speakerBar}>
          <div style={S.speakerBarHead}>
            <span style={S.speakerLabel}>说话人显示名</span>
            <span style={S.hint}>
              改完点最下方「确认修改」生效 · 导出与纪要都会用这个名字
            </span>
          </div>
          <div style={S.speakerChips}>
            {speakers.map((spk) => {
              const count = speakerCounts.get(spk) || 0;
              return (
                <div key={spk} style={S.speakerChip}>
                  <span style={{ ...S.dot, background: speakerColor(spk) }} />
                  <span style={S.spkId} title={spk}>{spk}</span>
                  <span style={S.arrow}>→</span>
                  <input
                    style={S.spkInput}
                    value={edit.names[spk] ?? ''}
                    placeholder="改名…"
                    onChange={(e) => dispatch({
                      type: 'rename', speaker: spk, name: e.target.value,
                    })}
                  />
                  <span style={S.spkCount}>{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 音频播放器由父级 MeetingDetailPage 统一渲染（与纪要证据跳转共用） */}

      {/* ── 片段列表 ── */}
      <div style={S.listWrap}>
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: '100%' }}
          data={edit.segments}
          itemContent={(_i, seg) => {
            const isActive = seg.id === (activeSegId ?? null);
            const editing = editingId === seg.id;
            const reassigning = reassignId === seg.id;
            const recMeta = transcript.recordings[seg.recording_index];
            const showRecHeader = _i === 0
              || edit.segments[_i - 1].recording_index !== seg.recording_index;
            return (
              <>
                {showRecHeader && recMeta && (
                  <div style={S.recHeader}>
                    <span style={S.recBadge}>录音 {seg.recording_index + 1}</span>
                    {recMeta.filename}
                    <span style={S.recHeaderTime}>
                      全局 {formatTime(recMeta.offset)} 起 · {formatTime(recMeta.duration)}
                    </span>
                  </div>
                )}
                <div style={{ ...S.seg, ...(isActive ? S.segActive : {}) }}>
                  <span style={S.time}>{formatTime(seg.start)}</span>

                  {/* 说话人标签：点击可改判这一句的归属 */}
                  <button
                    style={{
                      ...S.spkTag,
                      background: speakerColor(seg.speaker),
                      cursor: 'pointer',
                      border: 'none',
                    }}
                    title={`${displayName(seg.speaker)}（${seg.speaker}）\n点击改判这一句是谁说的`}
                    onClick={() => setReassignId(reassigning ? null : seg.id)}
                  >
                    {displayName(seg.speaker)}
                  </button>

                  {reassigning && (
                    <span style={S.reassignBox}>
                      <span style={S.reassignLabel}>这句其实是：</span>
                      <select
                        autoFocus
                        style={S.select}
                        value={seg.speaker}
                        onChange={(e) => {
                          dispatch({
                            type: 'reassignOne', id: seg.id, speaker: e.target.value,
                          });
                          setReassignId(null);
                        }}
                        onBlur={() => setReassignId(null)}
                      >
                        {speakers.map((spk) => (
                          <option key={spk} value={spk}>
                            {displayName(spk)}（{spk}）
                          </option>
                        ))}
                      </select>
                      <button style={S.miniBtn}
                              onClick={() => setReassignId(null)}>
                        取消
                      </button>
                    </span>
                  )}

                  {editing ? (
                    <textarea
                      autoFocus
                      style={S.textarea}
                      value={seg.text}
                      onChange={(e) => dispatch({
                        type: 'text', id: seg.id, text: e.target.value,
                      })}
                      onBlur={() => setEditingId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      style={{ ...S.text, ...(seg.text !== baseTextById.get(seg.id)
                        ? S.textEdited : {}) }}
                      onClick={() => playSegment(seg)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(seg.id);
                      }}
                      title="单击播放 · 双击编辑文字"
                    >
                      {seg.text}
                    </span>
                  )}

                  <button
                    style={S.playBtn}
                    title="从此处播放"
                    onClick={(e) => { e.stopPropagation(); playSegment(seg); }}
                  >
                    ▶
                  </button>
                </div>
              </>
            );
          }}
        />
      </div>

      {/* ── 底部确认栏 ── */}
      <div style={{ ...S.bottomBar, ...(dirty ? S.bottomBarDirty : {}) }}>
        <div style={S.changeSummary}>
          {dirty ? (
            <>
              <span style={S.changeBadge}>待保存 {total} 处</span>
              <span style={S.changeDetail}>
                {changes.text > 0 && <>文字 {changes.text} 段 </>}
                {changes.speaker > 0 && <>归属 {changes.speaker} 段 </>}
                {changes.renamed > 0 && <>说话人名 {changes.renamed} 个</>}
              </span>
              {edit.lastBatch && (
                <button
                  style={S.undoBatchBtn}
                  onClick={() => dispatch({ type: 'undoBatch' })}
                  title={`撤销「${displayName(edit.lastBatch.to)}」的批量改判`}
                >
                  ↶ 撤销本次批量操作
                </button>
              )}
            </>
          ) : (
            <span style={S.noChange}>{saveMsg || '暂无未保存的修改'}</span>
          )}
          {error && <span style={S.errorText}>{error}</span>}
        </div>
        <div style={S.bottomActions}>
          <button
            className="btn btn-secondary"
            style={S.smallBtn}
            onClick={() => dispatch({ type: 'undoAll' })}
            disabled={!dirty || saving}
          >
            撤销全部修改
          </button>
          <button
            className="btn btn-primary"
            style={{ ...S.smallBtn, minWidth: 116 }}
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? '保存中…' : dirty ? `确认修改（${total}）` : '已全部保存'}
          </button>
        </div>
      </div>

      {showBatch && (
        <BatchReassignDialog
          segments={edit.segments}
          displayName={displayName}
          speakers={speakers}
          onApply={(from, to) => dispatch({ type: 'reassignAll', from, to })}
          onClose={() => setShowBatch(false)}
        />
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' },
  toolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 18px', borderBottom: '1px solid #eee', flexShrink: 0, gap: 12,
  },
  toolLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  toolRight: { display: 'flex', gap: 8, alignItems: 'center' },
  stat: { fontSize: 13, color: '#555', fontWeight: 600 },
  recStat: { fontSize: 12, color: '#999', marginLeft: 4 },
  smallBtn: { padding: '5px 12px', fontSize: 12.5, borderRadius: 8 },

  speakerBar: {
    padding: '10px 18px', background: '#fafbfc',
    borderBottom: '1px solid #eee', flexShrink: 0,
  },
  speakerBarHead: {
    display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8,
  },
  speakerLabel: { fontSize: 12.5, fontWeight: 700, color: '#444' },
  hint: { fontSize: 11.5, color: '#999' },
  speakerChips: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  speakerChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#fff', border: '1px solid #e6e6ee',
    borderRadius: 8, padding: '5px 10px',
  },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  spkId: {
    fontSize: 11.5, color: '#888', fontFamily: 'ui-monospace, monospace',
    minWidth: 68,
  },
  arrow: { color: '#bbb', fontSize: 12 },
  spkInput: {
    width: 110, border: '1px solid #ddd', borderRadius: 8,
    padding: '3px 7px', fontSize: 13, outline: 'none',
  },
  spkCount: {
    fontSize: 11, color: '#4361ee', background: '#eef0ff',
    borderRadius: 9, padding: '1px 7px', fontWeight: 600,
  },

  listWrap: { flex: 1, minHeight: 0 },
  recHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 18px', background: '#f2f4ff',
    borderTop: '1px solid #e0e4ff', borderBottom: '1px solid #e0e4ff',
    fontSize: 12.5, color: '#444', fontWeight: 600,
  },
  recBadge: {
    background: '#4361ee', color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '2px 8px', borderRadius: 4,
  },
  recHeaderTime: { marginLeft: 'auto', color: '#8890b5', fontWeight: 400 },

  seg: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '7px 18px', borderBottom: '1px solid #f5f5f8',
    background: 'transparent',
  },
  segActive: { background: '#fffbe6' },
  time: {
    fontSize: 11.5, color: '#aaa', minWidth: 52, paddingTop: 3,
    fontVariantNumeric: 'tabular-nums', flexShrink: 0,
  },
  spkTag: {
    fontSize: 11.5, color: '#fff', fontWeight: 600,
    padding: '2px 8px', borderRadius: 4, flexShrink: 0,
    marginTop: 1, maxWidth: 96, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  reassignBox: {
    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
    background: '#fff', border: '1px solid #4361ee',
    borderRadius: 8, padding: '2px 6px',
  },
  reassignLabel: { fontSize: 11.5, color: '#666' },
  select: {
    fontSize: 12.5, border: '1px solid #ddd', borderRadius: 6,
    padding: '1px 4px', outline: 'none', background: '#fff',
  },
  miniBtn: {
    fontSize: 11, border: 'none', background: 'transparent',
    color: '#888', cursor: 'pointer', padding: '0 3px',
  },
  text: { fontSize: 13.5, lineHeight: 1.75, color: '#333', flex: 1, cursor: 'pointer' },
  textEdited: { background: '#fff3cd', borderRadius: 3 },
  textarea: {
    flex: 1, fontSize: 13.5, lineHeight: 1.7, color: '#333',
    border: '1px solid #4361ee', borderRadius: 8, padding: '5px 8px',
    outline: 'none', resize: 'vertical', minHeight: 52, fontFamily: 'inherit',
  },
  playBtn: {
    border: 'none', background: 'transparent', color: '#4361ee',
    cursor: 'pointer', fontSize: 13, padding: '2px 4px', flexShrink: 0,
  },

  bottomBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 12, padding: '10px 18px', flexShrink: 0,
    borderTop: '1px solid #eee', background: '#fafafa',
  },
  bottomBarDirty: {
    background: '#fff8e6', borderTop: '1px solid #f0d9a0',
  },
  changeSummary: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  changeBadge: {
    fontSize: 12.5, fontWeight: 700, color: '#8a6100',
    background: '#ffe9b0', borderRadius: 10, padding: '2px 10px',
  },
  changeDetail: { fontSize: 12, color: '#8a6100' },
  undoBatchBtn: {
    fontSize: 11.5, color: '#8a6100', background: '#fff',
    border: '1px solid #e8cf94', borderRadius: 8,
    padding: '2px 9px', cursor: 'pointer',
  },
  noChange: { fontSize: 12.5, color: '#999' },
  errorText: { fontSize: 12.5, color: '#d33' },
  bottomActions: { display: 'flex', gap: 8, flexShrink: 0 },
};
