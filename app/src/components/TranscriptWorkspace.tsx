import { useMemo, useRef, useState, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import * as api from '../services/api';
import { formatTime, speakerColor } from '../utils/format';
import type { MergedSegment, MergedTranscript } from '../types';

interface Props {
  projectId: string;
  transcript: MergedTranscript;
  onSaved?: () => void;
  /** 当前高亮的片段（由父级共享播放器驱动，如从纪要证据跳转过来） */
  activeSegId?: string | null;
  /** 请求播放某段录音的某个本地时间点（父级持有唯一的 <audio>） */
  onPlay?: (recordingId: string, localStart: number, segId?: string) => void;
}

/** 待保存的改动统计 */
interface ChangeSummary {
  text: number;       // 改过文字的段数
  speaker: number;    // 改过归属的段数
  renamed: number;    // 改过显示名的说话人数
}

/**
 * 合并文档工作区 —— 转录完成后的全部修改都在这里。
 *
 * 三类修改（对应腾讯会议纪要的编辑能力）：
 *   1. **改说话人名**：顶部「说话人」区，SPEAKER_0 → 「leader」，全局生效
 *   2. **改单句归属**：点句首的说话人标签，改判这一句是谁说的
 *   3. **改文字**：双击正文校对
 *
 * 所有修改先留在本地（草稿态），底部确认栏汇总「待保存 N 处」，
 * 点「确认修改」才写回后端；「撤销全部修改」回到上次保存的状态。
 *
 * 音频播放器由父级 MeetingDetailPage 统一持有（`onPlay`），
 * 使纪要里的「证据」跳转与这里的点击播放共用同一个播放器。
 */
export default function TranscriptWorkspace({
  projectId, transcript, onSaved, activeSegId, onPlay,
}: Props) {
  const [segments, setSegments] = useState<MergedSegment[]>(transcript.segments);
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>(
    transcript.speaker_map || {},
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');
  /** 正在改归属的那一段（展开下拉） */
  const [reassignId, setReassignId] = useState<string | null>(null);
  /** 折叠/展开顶部说话人区（段数多时省空间） */
  const [showSpeakerBar, setShowSpeakerBar] = useState(true);

  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // 基线：上次保存（或初始加载）的状态，用于算改动数、也用于撤销
  const [baseline, setBaseline] = useState(() => ({
    segments: transcript.segments,
    speakerMap: transcript.speaker_map || {},
  }));

  // transcript 变更时同步本地编辑态。
  // React 官方推荐的"props 变化时重置 state"做法是**在渲染期间比较并重置**，
  // 而不是放进 effect —— 后者会造成一次多余的级联渲染（且被 lint 判为问题）。
  const [syncedFrom, setSyncedFrom] = useState(transcript);
  if (syncedFrom !== transcript) {
    setSyncedFrom(transcript);
    setSegments(transcript.segments);
    setSpeakerMap(transcript.speaker_map || {});
    setBaseline({
      segments: transcript.segments,
      speakerMap: transcript.speaker_map || {},
    });
    setSaveMsg('');
    setError('');
  }

  /** 当前出现的说话人标签（按发言数降序，主要发言人排在前面） */
  const speakers = useMemo(() => {
    const count = new Map<string, number>();
    segments.forEach((s) => count.set(s.speaker, (count.get(s.speaker) || 0) + 1));
    return Array.from(count.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([spk]) => spk);
  }, [segments]);

  const displayName = useCallback(
    (spk: string) => speakerMap[spk] || spk,
    [speakerMap],
  );

  /** 改动统计 —— 驱动底部确认栏 */
  const changes: ChangeSummary = useMemo(() => {
    const baseSeg = new Map(baseline.segments.map((s) => [s.id, s]));
    let text = 0;
    let speaker = 0;
    for (const s of segments) {
      const b = baseSeg.get(s.id);
      if (!b) continue;
      if (s.text !== b.text) text += 1;
      if (s.speaker !== b.speaker) speaker += 1;
    }
    const keys = new Set([
      ...Object.keys(baseline.speakerMap), ...Object.keys(speakerMap),
    ]);
    let renamed = 0;
    keys.forEach((k) => {
      if ((baseline.speakerMap[k] || '') !== (speakerMap[k] || '')) renamed += 1;
    });
    return { text, speaker, renamed };
  }, [segments, speakerMap, baseline]);

  const totalChanges = changes.text + changes.speaker + changes.renamed;
  const dirty = totalChanges > 0;

  // 性能：行渲染里不能做 O(n) 查找（587 行会变成 587² 次比较）。
  // 预先建索引，渲染时 O(1)。
  const baseTextById = useMemo(() => {
    const m = new Map<string, string>();
    baseline.segments.forEach((s) => m.set(s.id, s.text));
    return m;
  }, [baseline]);

  const speakerCounts = useMemo(() => {
    const m = new Map<string, number>();
    segments.forEach((s) => m.set(s.speaker, (m.get(s.speaker) || 0) + 1));
    return m;
  }, [segments]);

  // ── 播放：交给父级统一持有的播放器 ───────────────────────────
  const playSegment = useCallback((seg: MergedSegment) => {
    if (onPlay) onPlay(seg.recording_id, seg.local_start, seg.id);
  }, [onPlay]);

  // ── 编辑 ─────────────────────────────────────────────────────
  const updateText = (id: string, text: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
    setSaveMsg('');
  };

  const updateSpeakerName = (spkId: string, name: string) => {
    setSpeakerMap((prev) => ({ ...prev, [spkId]: name }));
    setSaveMsg('');
  };

  /** 改判某一句的归属 */
  const reassignSegment = (id: string, speaker: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, speaker } : s)));
    setReassignId(null);
    setSaveMsg('');
  };

  /** 撤销全部未保存的修改 */
  const undoAll = () => {
    setSegments(baseline.segments);
    setSpeakerMap(baseline.speakerMap);
    setEditingId(null);
    setReassignId(null);
    setSaveMsg('');
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    setError('');
    try {
      const res = await api.saveTranscriptEdits(projectId, {
        segments: segments.map((s) => ({
          id: s.id, text: s.text, speaker: s.speaker,
        })),
        speaker_map: speakerMap,
      });
      // 以服务端返回为准刷新基线 —— 避免本地与服务端不一致时反复"看起来还有改动"
      const saved = res.transcript;
      if (saved?.segments) {
        setBaseline({
          segments: saved.segments,
          speakerMap: saved.speaker_map || {},
        });
        setSegments(saved.segments);
        setSpeakerMap(saved.speaker_map || {});
      } else {
        setBaseline({ segments, speakerMap });
      }
      setSaveMsg(`已保存 ${res.updated} 处`);
      setEditingId(null);
      setReassignId(null);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async (fmt: 'txt' | 'json') => {
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
  };

  return (
    <div style={S.wrap}>
      {/* ── 顶部工具条 ── */}
      <div style={S.toolbar}>
        <div style={S.toolLeft}>
          <span style={S.stat}>{segments.length} 段</span>
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
                    value={speakerMap[spk] ?? ''}
                    placeholder="改名…"
                    onChange={(e) => updateSpeakerName(spk, e.target.value)}
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
          data={segments}
          itemContent={(_i, seg) => {
            const isActive = seg.id === (activeSegId ?? null);
            const editing = editingId === seg.id;
            const reassigning = reassignId === seg.id;
            const recMeta = transcript.recordings[seg.recording_index];
            const showRecHeader = _i === 0
              || segments[_i - 1].recording_index !== seg.recording_index;
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
                        onChange={(e) => reassignSegment(seg.id, e.target.value)}
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
                      onChange={(e) => updateText(seg.id, e.target.value)}
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
                      onDoubleClick={() => setEditingId(seg.id)}
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
              <span style={S.changeBadge}>待保存 {totalChanges} 处</span>
              <span style={S.changeDetail}>
                {changes.text > 0 && <>文字 {changes.text} 段 </>}
                {changes.speaker > 0 && <>归属 {changes.speaker} 段 </>}
                {changes.renamed > 0 && <>说话人名 {changes.renamed} 个</>}
              </span>
            </>
          ) : (
            <span style={S.noChange}>
              {saveMsg || '暂无未保存的修改'}
            </span>
          )}
          {error && <span style={S.errorText}>{error}</span>}
        </div>
        <div style={S.bottomActions}>
          <button
            className="btn btn-secondary"
            style={S.smallBtn}
            onClick={undoAll}
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
            {saving ? '保存中…' : dirty ? `确认修改（${totalChanges}）` : '已全部保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' },
  toolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 18px', borderBottom: '1px solid #e6e6ee', flexShrink: 0, gap: 12,
  },
  toolLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  toolRight: { display: 'flex', gap: 8, alignItems: 'center' },
  stat: { fontSize: 13, color: '#555', fontWeight: 600 },
  recStat: { fontSize: 12, color: '#999', marginLeft: 4 },
  smallBtn: { padding: '5px 12px', fontSize: 12.5 },

  speakerBar: {
    padding: '10px 18px', background: '#fafbff',
    borderBottom: '1px solid #e6e6ee', flexShrink: 0,
  },
  speakerBarHead: {
    display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8,
  },
  speakerLabel: { fontSize: 12.5, fontWeight: 700, color: '#444' },
  hint: { fontSize: 11.5, color: '#999' },
  speakerChips: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  speakerChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#fff', border: '1px solid #e2e2ee',
    borderRadius: 8, padding: '5px 10px',
  },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  spkId: {
    fontSize: 11.5, color: '#888', fontFamily: 'ui-monospace, monospace',
    minWidth: 68,
  },
  arrow: { color: '#bbb', fontSize: 12 },
  spkInput: {
    width: 110, border: '1px solid #ddd', borderRadius: 5,
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
    padding: '7px 18px', borderBottom: '1px solid #f4f4f8',
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
    borderRadius: 6, padding: '2px 6px',
  },
  reassignLabel: { fontSize: 11.5, color: '#666' },
  select: {
    fontSize: 12.5, border: '1px solid #ddd', borderRadius: 4,
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
    border: '1px solid #4361ee', borderRadius: 5, padding: '5px 8px',
    outline: 'none', resize: 'vertical', minHeight: 52, fontFamily: 'inherit',
  },
  playBtn: {
    border: 'none', background: 'transparent', color: '#4361ee',
    cursor: 'pointer', fontSize: 13, padding: '2px 4px', flexShrink: 0,
  },

  bottomBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 12, padding: '10px 18px', flexShrink: 0,
    borderTop: '1px solid #e6e6ee', background: '#fafafa',
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
  noChange: { fontSize: 12.5, color: '#999' },
  errorText: { fontSize: 12.5, color: '#d33' },
  bottomActions: { display: 'flex', gap: 8, flexShrink: 0 },
};
