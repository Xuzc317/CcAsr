import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { formatDuration } from '../utils/format';
import type { Project } from '../types';
import { Badge, EmptyState, Banner, Progress } from './ui';
import type { BadgeTone } from './ui';
import Logo from './Logo';

const STATE_LABEL: Record<string, string> = {
  draft: '待添加录音',
  transcribing: '转录中',
  summarizing: '生成纪要中',
  completed: '已完成',
  failed: '失败',
};

/** 项目状态 → 统一徽标语义（与录音、纪要共用同一套五态色） */
function stateTone(state: string, hasSummary: boolean): BadgeTone {
  switch (state) {
    case 'failed': return 'err';
    case 'completed': return hasSummary ? 'ok' : 'warn';
    case 'transcribing':
    case 'summarizing': return 'run';
    default: return 'mut';
  }
}

/** 2026/10/12 13:37 —— 等宽数字，列对齐不靠侥幸 */
function formatStamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
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

  // 初次加载。
  // 说明：refresh() 内部所有 setState 都在 await 之后，属异步更新、
  // 不会造成级联渲染；这里显式用 void + 微任务避免 lint 误判为同步 setState。
  useEffect(() => {
    void Promise.resolve().then(refresh);
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
    <div className="container">
      <div className="page-head">
        <div>
          <h1 className="t-h1">我的会议</h1>
          <p className="lead">一个会议可导入多段录音，按顺序自动转录并合并为同一份纪要</p>
        </div>
      </div>

      {/* 新建会议 */}
      <div className="list-create">
        <input
          className="field"
          placeholder="输入会议名称，例如：11月产品评审会"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          aria-label="会议名称"
        />
        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
        >
          {creating ? '创建中…' : '＋ 新建会议'}
        </button>
      </div>

      {error && <Banner tone="err">{error}</Banner>}

      {loading ? (
        <EmptyState animatedLogo title="正在加载会议列表…" />
      ) : projects.length === 0 ? (
        <EmptyState
          animatedLogo
          title="还没有会议"
          hint="在上方输入名称新建一个，然后拖入会议录音 —— 会自动排队转录并生成纪要。"
          actions={(
            <button
              className="btn btn-secondary"
              onClick={() => document.querySelector<HTMLInputElement>('.list-create .field')?.focus()}
            >
              开始新建
            </button>
          )}
        />
      ) : (
        <div className="m-grid">
          {projects.map((p) => {
            const busy = p.state === 'transcribing' || p.state === 'summarizing';
            const pct = p.state === 'summarizing'
              ? p.summary_progress * 100
              : p.progress * 100;
            return (
              <div
                key={p.project_id}
                className="m-card"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/meeting/${p.project_id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/meeting/${p.project_id}`);
                  }
                }}
              >
                <div className="top">
                  <span className="nm">{p.name}</span>
                  <Badge
                    tone={stateTone(p.state, p.has_summary)}
                    dot={busy}
                  >
                    {STATE_LABEL[p.state] || p.state}
                  </Badge>
                </div>

                <div className="meta">
                  <span>🎧 {p.recording_count} 段录音</span>
                  {p.total_duration > 0 && (
                    <span>⏱ {formatDuration(p.total_duration)}</span>
                  )}
                  {p.has_summary && <span>📄 有纪要</span>}
                </div>

                {busy && (
                  <div className="m-progress">
                    <Progress
                      value={pct}
                      label={p.state === 'summarizing'
                        ? `生成纪要中 ${Math.round(p.summary_progress * 100)}%`
                        : `已转录 ${p.done_count}/${p.recording_count} 段`}
                    />
                  </div>
                )}

                {p.failed_count > 0 && (
                  <div className="fail-note">⚠ {p.failed_count} 段录音失败</div>
                )}

                {p.updated_at && (
                  <div className="date">{formatStamp(p.updated_at)}</div>
                )}

                <button
                  className="x"
                  title="删除会议"
                  aria-label={`删除会议 ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); void handleDelete(p); }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!loading && projects.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginTop: 16, fontSize: 12, color: 'var(--ink-3)',
        }}>
          <Logo size={16} flat />
          共 {projects.length} 个会议 · 处理中的会议会自动刷新
        </div>
      )}
    </div>
  );
}
