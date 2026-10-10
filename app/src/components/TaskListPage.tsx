import { useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTaskStore } from '../stores/taskStore';
import type { Task, TaskStatus } from '../types';

const STATUS_CONFIG: Record<
  TaskStatus,
  { bg: string; color: string; label: string }
> = {
  pending: { bg: '#fff3cd', color: '#856404', label: '等待中' },
  processing: { bg: '#cce5ff', color: '#004085', label: '处理中' },
  completed: { bg: '#d4edda', color: '#155724', label: '已完成' },
  failed: { bg: '#f8d7da', color: '#721c24', label: '失败' },
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 720,
    margin: '40px auto',
    padding: '0 24px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: '#1a1a2e',
    margin: 0,
  },
  uploadBtn: {
    padding: '8px 20px',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: '#4361ee',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    marginBottom: 8,
    background: '#fff',
    border: '1px solid #e9ecef',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'box-shadow 0.15s, border-color 0.15s',
  },
  listItemHover: {
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    borderColor: '#c0c0c0',
  },
  listItemCompleted: {
    cursor: 'pointer',
  },
  listItemNonCompleted: {
    cursor: 'default',
    opacity: 0.85,
  },
  fileInfo: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: 15,
    fontWeight: 600,
    color: '#1a1a2e',
    marginBottom: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  fileTime: {
    fontSize: 12,
    color: '#888',
  },
  badge: {
    display: 'inline-block',
    padding: '3px 10px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 12,
    whiteSpace: 'nowrap' as const,
  },
  empty: {
    textAlign: 'center' as const,
    padding: '60px 20px',
    color: '#999',
    fontSize: 15,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  loading: {
    textAlign: 'center' as const,
    padding: 40,
    color: '#888',
  },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      style={{
        ...styles.badge,
        background: cfg.bg,
        color: cfg.color,
      }}
    >
      {cfg.label}
    </span>
  );
}

function TaskRow({ task }: { task: Task }) {
  const navigate = useNavigate();
  const isCompleted = task.status === 'completed';

  const handleClick = useCallback(() => {
    if (isCompleted) {
      navigate(`/task/${task.id}`);
    }
  }, [isCompleted, navigate, task.id]);

  return (
    <li
      style={{
        ...styles.listItem,
        ...(isCompleted ? styles.listItemCompleted : styles.listItemNonCompleted),
      }}
      onClick={handleClick}
      onMouseEnter={(e) => {
        if (isCompleted) {
          Object.assign(e.currentTarget.style, styles.listItemHover);
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.borderColor = '#e9ecef';
      }}
    >
      <div style={styles.fileInfo}>
        <div style={styles.fileName}>🎵 {task.filename}</div>
        <div style={styles.fileTime}>{formatTime(task.createdAt)}</div>
      </div>
      <StatusBadge status={task.status} />
    </li>
  );
}

export default function TaskListPage() {
  const tasks = useTaskStore((s) => s.tasks);
  const isLoading = useTaskStore((s) => s.isLoading);
  const fetchTasks = useTaskStore((s) => s.fetchTasks);

  useEffect(() => {
    fetchTasks();
    // Polling is handled automatically by taskStore.startPolling()
    // which is called inside fetchTasks when there are processing tasks.
    return () => {
      useTaskStore.getState().stopPolling();
    };
  }, [fetchTasks]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>📋 转录任务</h1>
        <Link to="/upload" style={styles.uploadBtn}>
          + 上传新文件
        </Link>
      </div>

      {isLoading && tasks.length === 0 && (
        <div style={styles.loading}>加载中…</div>
      )}

      {!isLoading && tasks.length === 0 && (
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>📭</div>
          暂无任务
          <br />
          <Link to="/upload" style={{ color: '#4361ee', marginTop: 8, display: 'inline-block' }}>
            上传第一个音频文件
          </Link>
        </div>
      )}

      <ul style={styles.list}>
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
    </div>
  );
}
