import { useMemo, useRef, useState, useCallback } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import * as api from '../services/api';
import { formatTime, pickSpeakerColor } from '../utils/format';
import type { SpeakerColorMap } from '../utils/format';
import type { MergedSegment, MergedTranscript } from '../types';
import type { EditAction, EditState } from '../utils/editState';
import { computeChanges, speakerOrder, totalChanges } from '../utils/editState';
import BatchReassignDialog from './BatchReassignDialog';
import { SpeakerTag } from './ui';

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
  /** 说话人 → 颜色（页面层分配的序号色，保证跨视图同人同色） */
  speakerColors?: SpeakerColorMap;
}

/**
 * GroupedVirtuoso 的列表容器替身。
 *
 * 每组（每段录音）的行都落在这一个盒子里，于是组内的行可以拼成一张连续
 * 列表：外框只画一圈，行与行之间只有一条分割线。用默认包装元素的话，
 * 每行是独立盒子、各画一圈边框，视觉上就成了「一张张带缝隙的小卡片」。
 */
function SegRowsList({
  children, style, ...rest
}: React.ComponentProps<'div'> & { context?: unknown }) {
  return (
    <div {...rest} style={style} className="seg-rows">{children}</div>
  );
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
  activeSegId, onPlay, onExportWithDraft, speakerColors,
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

  /**
   * 按录音分组渲染。
   *
   * 用 GroupedVirtuoso 而不是「在行里塞分组头」，是为了让**同段录音的行
   * 落在同一个 DOM 容器里** —— 这样它们能拼成一张连续的列表（共用边框、
   * 只在首尾圆角），而不是一行一张带缝隙的小卡片。
   * 录音头只在不可见的度量阶段渲染，分组计数中记 0。
   */
  const { groupCounts } = useMemo(() => {
    const counts = new Map<number, number>();
    edit.segments.forEach((s) => {
      counts.set(s.recording_index, (counts.get(s.recording_index) || 0) + 1);
    });
    return {
      groupCounts: [...counts.keys()]
        .sort((a, b) => a - b)
        .map((k) => counts.get(k) as number),
    };
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
    <div className="ws">
      {/* ── 工具条：统计 · 说话人 · 批量改判 · 导出 · 保存状态 ── */}
      <div className="ws-tools">
        <span className="stat">{edit.segments.length} 段</span>
        <span className="stat stat-sep">·</span>
        <span className="stat">{speakers.length} 位说话人</span>
        <span className="stat stat-sep">·</span>
        <span className="stat">{formatTime(transcript.duration)}</span>
        <span className="stat stat-sep">·</span>
        <span className="stat">{transcript.recordings.length} 段录音</span>

        <div className="tools-right">
          {/* 「已保存」常驻按钮改为轻量状态文字；需要确认时才出现主按钮 */}
          <span className="save-status" aria-live="polite">
            {dirty
              ? <span className="dirty">● 待保存 {total} 处</span>
              : <span className="ok">✓ {saveMsg || '所有更改已保存'}</span>}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowBatch(true)}
            disabled={speakers.length < 2}
            title={speakers.length < 2
              ? '只有一个说话人，无需批量改判'
              : '把某人的全部发言改归另一人'}
          >
            ⇄ 批量改判
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowSpeakerBar((v) => !v)}
          >
            {showSpeakerBar ? '收起说话人' : `说话人 (${speakers.length})`}
          </button>
          <button className="btn btn-secondary btn-sm"
                  onClick={() => handleExport('txt')}>
            ⬇ TXT
          </button>
          <button className="btn btn-secondary btn-sm"
                  onClick={() => handleExport('json')}>
            ⬇ JSON
          </button>
        </div>
      </div>

      {/* ── 说话人改名：一条工具条，不再单独占一层 ── */}
      {showSpeakerBar && (
        <div className="speaker-bar">
          <span className="label">说话人</span>
          <div className="speaker-chips">
            {speakers.map((spk) => {
              const count = speakerCounts.get(spk) || 0;
              return (
                <div key={spk} className="speaker-chip">
                  <i
                    style={{
                      width: 8, height: 8, borderRadius: 3, display: 'inline-block',
                      background: pickSpeakerColor(spk, speakerColors),
                    }}
                  />
                  <span className="sid" title={spk}>{spk}</span>
                  <span className="arrow">→</span>
                  <input
                    className="name-input"
                    value={edit.names[spk] ?? ''}
                    placeholder="改名…"
                    aria-label={`${spk} 的显示名`}
                    onChange={(e) => dispatch({
                      type: 'rename', speaker: spk, name: e.target.value,
                    })}
                  />
                  <span className="count" title={`${count} 段发言`}>{count}</span>
                </div>
              );
            })}
          </div>
          <span className="hint">改完点右下「确认修改」生效 · 导出与纪要都会用这个名字</span>
        </div>
      )}

      {/* 音频播放器由父级 MeetingDetailPage 统一渲染（与纪要证据跳转共用） */}

      {/* ── 片段列表（虚拟滚动，按录音分组） ── */}
      <div className="seg-list">
        <GroupedVirtuoso
          ref={virtuosoRef}
          style={{ height: '100%' }}
          groupCounts={groupCounts}
          groupContent={(groupIndex) => {
            const meta = transcript.recordings[groupIndex];
            return (
              <div className="seg-rec-head">
                <span className="tag">录音 {groupIndex + 1}</span>
                <span>{meta?.filename}</span>
                <span className="range">
                  全局 {formatTime(meta?.offset ?? 0)} 起 · {formatTime(meta?.duration ?? 0)}
                </span>
              </div>
            );
          }}
          components={{
            // 每段录音的行装进同一个盒子，才能拼成一张连续列表
            // （虚拟列表默认给每行一个独立包装元素，逐行加边框会变成「卡片 + 缝隙」）
            List: SegRowsList,
          }}
          itemContent={(index) => {
            // GroupedVirtuoso 的 itemContent 只给扁平下标（Data 泛型要配合 data 属性，
            // 而这里的数据源是 groupCounts），因此按下标取回片段，类型在此显式收窄
            const seg = edit.segments[index] as MergedSegment | undefined;
            if (!seg) return null;
            const isActive = seg.id === (activeSegId ?? null);
            const editing = editingId === seg.id;
            const reassigning = reassignId === seg.id;
            return (
              <div className={`seg${isActive ? ' active' : ''}`}>
                <span className="seg-time">{formatTime(seg.start)}</span>

                {/* 说话人标签：点击可改判这一句的归属 */}
                <SpeakerTag
                  speaker={seg.speaker}
                  name={displayName(seg.speaker)}
                  colorMap={speakerColors}
                  onClick={() => setReassignId(reassigning ? null : seg.id)}
                  title={`${displayName(seg.speaker)}（${seg.speaker}）\n点击改判这一句是谁说的`}
                />

                {reassigning && (
                  <span className="seg-reassign">
                    <span className="label">这句其实是：</span>
                    <select
                      autoFocus
                      value={seg.speaker}
                      aria-label="改判说话人"
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
                    <button className="link-btn"
                            onClick={() => setReassignId(null)}>
                      取消
                    </button>
                  </span>
                )}

                {editing ? (
                  <textarea
                    autoFocus
                    className="txt-edit"
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
                    className={`txt${seg.text !== baseTextById.get(seg.id) ? ' edited' : ''}`}
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
                    className="go"
                    title="从此处播放"
                    aria-label="从此处播放"
                    onClick={(e) => { e.stopPropagation(); playSegment(seg); }}
                  >
                    ▶
                  </button>
              </div>
            );
          }}
        />
      </div>

      {/* ── 底部确认栏 ── */}
      <div className={`ws-foot${dirty ? ' dirty' : ''}`}>
        <div className="changes">
          {dirty ? (
            <>
              <span className="count">待保存 {total} 处</span>
              <span className="detail">
                {changes.text > 0 && <>文字 {changes.text} 段 </>}
                {changes.speaker > 0 && <>归属 {changes.speaker} 段 </>}
                {changes.renamed > 0 && <>说话人名 {changes.renamed} 个</>}
              </span>
              {edit.lastBatch && (
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => dispatch({ type: 'undoBatch' })}
                  title={`撤销「${displayName(edit.lastBatch.to)}」的批量改判`}
                >
                  ↶ 撤销本次批量操作
                </button>
              )}
            </>
          ) : (
            <span className="save-status">{saveMsg || '暂无未保存的修改'}</span>
          )}
          {error && <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</span>}
        </div>
        <div className="actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => dispatch({ type: 'undoAll' })}
            disabled={!dirty || saving}
          >
            撤销全部修改
          </button>
          <button
            className="btn btn-primary btn-sm"
            style={{ minWidth: 124 }}
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
          speakerColors={speakerColors}
          onApply={(from, to) => dispatch({ type: 'reassignAll', from, to })}
          onClose={() => setShowBatch(false)}
        />
      )}
    </div>
  );
}
