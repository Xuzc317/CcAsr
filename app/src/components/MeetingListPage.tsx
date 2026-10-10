import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { formatDuration } from '../utils/format';
import type { Project } from '../types';

const STATE_LABEL: Record<string, string> = {
  draft: '待添加录音',
  transcribing: '转录中',
  summarizing: '生成纪要中',
  completed: '已完成',
  failed: '失败',
};

function stateColor(state: string, hasSummary: boolean): string {
  if (state === 'failed') return '#e94560';
  if (state === 'completed') return hasSummary ? '#2a9d8f' : '#f4a261';
  return '#4361ee';
}

export default function MeetingListPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 有项目正在处理时自动轮询列表状态
  useEffect(() => {
    const busy = projects.some(
      (p) => p.state === 'transcribing' || p.state === 'summarizing',
    );
    if (!busy) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [projects, refresh]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const p = await api.createProject(name);
      setNewName('');
      navigate(`/meeting/${p.project_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (p: Project) => {
    if (!confirm(`删除会议「${p.name}」？其转录结果与纪要将一并删除，不可恢复。`)) return;
    try {
      await api.deleteProject(p.project_id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div style={S.page}>
      <div style={S.head}>
        <div>
          <h2 style={S.h2}>我的会议</h2>
          <p style={S.hint}>
            一个会议可导入多段录音，按顺序自动转录并合并为同一份纪要
          </p>
        </div>
      </div>

      {/* 新建会议 */}
      <div style={S.createBar}>
        <input
          style={S.input}
          placeholder="输入会议名称，例如：11月产品评审会"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
        >
          {creating ? '创建中…' : '＋ 新建会议'}
        </button>
      </div>

      {error && <div style={S.error}>{error}</div>}

      {loading ? (
        <div style={S.empty}>加载中…</div>
      ) : projects.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎙</div>
          <div>还没有会议，先在上方建一个吧</div>
        </div>
      ) : (
        <div style={S.grid}>
          {projects.map((p) => {
            const color = stateColor(p.state, p.has_summary);
            return (
              <div
                key={p.project_id}
                style={S.card}
                onClick={() => navigate(`/meeting/${p.project_id}`)}
              >
                <div style={{ ...S.cardAccent, background: color }} />
                <div style={S.cardBody}>
                  <div style={S.cardTitleRow}>
                    <span style={S.cardTitle}>{p.name}</span>
                    <span style={{ ...S.badge, background: color }}>
                      {STATE_LABEL[p.state] || p.state}
                    </span>
                  </div>

                  <div style={S.metaRow}>
                    <span>🎧 {p.recording_count} 段录音</span>
                    {p.total_duration > 0 && (
                      <span>⏱ {formatDuration(p.total_duration)}</span>
                    )}
                    {p.has_summary && <span>📝 有纪要</span>}
                  </div>

                  {(p.state === 'transcribing' || p.state === 'summarizing') && (
                    <>
                      <div style={S.progressTrack}>
                        <div
                          style={{
                            ...S.progressFill,
                            width: `${Math.round(p.progress * 100)}%`,
                            background: color,
                          }}
                        />
                      </div>
                      <div style={S.progressText}>
                        {p.state === 'summarizing'
                          ? `生成纪要中 ${Math.round(p.summary_progress * 100)}%`
                          : `已转录 ${p.done_count}/${p.recording_count} 段`}
                      </div>
                    </>
                  )}

                  {p.failed_count > 0 && (
                    <div style={S.failNote}>⚠ {p.failed_count} 段录音失败</div>
                  )}

                  {p.updated_at && (
                    <div style={S.timeNote}>
                      {new Date(p.updated_at).toLocaleString('zh-CN')}
                    </div>
                  )}
                </div>

                <button
                  style={S.delBtn}
                  title="删除会议"
                  onClick={(e) => { e.stopPropagation(); handleDelete(p); }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1040, margin: '0 auto' },
  head: { marginBottom: 18 },
  h2: { fontSize: 20, fontWeight: 700, color: '#1a1a2e' },
  hint: { fontSize: 13, color: '#888', marginTop: 4 },
  createBar: { display: 'flex', gap: 10, marginBottom: 20 },
  input: {
    flex: 1, padding: '10px 14px', fontSize: 14, fontFamily: 'inherit',
    border: '1px solid #d8d8e0', borderRadius: 8, outline: 'none', color: '#1a1a2e',
  },
  error: {
    padding: '10px 14px', background: '#fff0f0', border: '1px solid #ffcccc',
    borderRadius: 8, color: '#cc3333', fontSize: 13, marginBottom: 16,
  },
  empty: { textAlign: 'center', padding: '60px 0', color: '#999', fontSize: 14 },
  grid: {
    display: 'grid', gap: 12,
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  },
  card: {
    position: 'relative', display: 'flex', background: '#fff',
    border: '1px solid #e6e6ee', borderRadius: 10, cursor: 'pointer',
    overflow: 'hidden', transition: 'box-shadow .15s, transform .15s',
  },
  cardAccent: { width: 4, flexShrink: 0 },
  cardBody: { flex: 1, padding: '14px 16px', minWidth: 0 },
  cardTitleRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15, fontWeight: 700, color: '#1a1a2e',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  badge: {
    fontSize: 11, color: '#fff', padding: '2px 8px', borderRadius: 10,
    flexShrink: 0, fontWeight: 600,
  },
  metaRow: {
    display: 'flex', gap: 14, fontSize: 12, color: '#777', flexWrap: 'wrap',
  },
  progressTrack: {
    height: 5, background: '#eee', borderRadius: 3, marginTop: 10, overflow: 'hidden',
  },
  progressFill: { height: '100%', transition: 'width .3s' },
  progressText: { fontSize: 11, color: '#888', marginTop: 5 },
  failNote: { fontSize: 12, color: '#e94560', marginTop: 6 },
  timeNote: { fontSize: 11, color: '#bbb', marginTop: 8 },
  delBtn: {
    position: 'absolute', top: 8, right: 8, border: 'none', background: 'none',
    color: '#ccc', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 4,
  },
};
