import { useCallback, useEffect, useState } from 'react';

/**
 * 定制迷你播放器（UI 2.0 第 05 节 5.2 设计稿）。
 *
 * 换肤而非换引擎：`<audio>` 元素仍由页面层持有（`audioRef`），
 * 因为纪要的「证据」跳转与转录行的点击播放必须共用同一个播放源，
 * 两处各持一个播放器会导致状态互相打架。这里只做三件事：
 *   1. 隐藏原生控件，用品牌化控件驱动它
 *   2. 把 <audio> 的原生事件同步成 React 状态（播放/暂停/进度/时长/倍速）
 *   3. 把「拖动进度条」翻译成 currentTime 赋值
 *
 * 拖动定位用原生 input[type=range] 做覆盖层：它自带键盘方向键、
 * Home/End 与 ARIA 语义，手写 pointer 拖拽在无障碍上是倒退。
 */

interface Props {
  /** 页面层持有的唯一 <audio>（src 由页面层按录音切换） */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** 当前已加载的录音 id；null 表示还没加载任何音频 */
  recordingId: string | null;
  /** 当前录音文件名（展示用） */
  label?: string;
  /** 队列里是否有音频可播 */
  hasAudio: boolean;
  /** 还没加载音频时点播放：请求页面层加载第一段 */
  onRequestFirst?: () => void;
}

const RATES = [0.75, 1, 1.25, 1.5, 2];

/** 1 → "1.0×"，1.25 → "1.25×" */
const rateLabel = (r: number) => `${Number.isInteger(r) ? r.toFixed(1) : r}×`;

function clock(sec: number): string {
  const v = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export default function AudioBar({
  audioRef, recordingId, label, hasAudio, onRequestFirst,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false);

  // 绑定原生媒体事件 → React 状态
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onTime = () => setNow(el.currentTime || 0);
    const onMeta = () => {
      setDur(el.duration || 0);
      setReady(true);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onPause);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onPause);
    };
  }, [audioRef]);

  // 倍速独立同步：换源后 <audio> 会重置 playbackRate，这里兜住
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [audioRef, rate, recordingId]);

  /** 换源后补一次状态同步（页面层已设好 currentTime，这里把 UI 拉齐） */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !recordingId) return;
    const sync = () => {
      setNow(el.currentTime || 0);
      setDur(el.duration || 0);
      setReady(true);
      setPlaying(!el.paused);
    };
    sync();
    el.addEventListener('loadedmetadata', sync);
    return () => el.removeEventListener('loadedmetadata', sync);
  }, [audioRef, recordingId]);

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = t;
      setNow(t);
    } catch { /* 元数据未就绪，等 loadedmetadata 后原生自会同步 */ }
  }, [audioRef]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el || !hasAudio) return;
    if (!recordingId) {
      onRequestFirst?.();
      return;
    }
    if (el.paused) void el.play().catch(() => { /* 自动播放策略拦截 */ });
    else el.pause();
  }, [audioRef, recordingId, hasAudio, onRequestFirst]);

  const cycleRate = () => {
    setRate((prev) => RATES[(RATES.indexOf(prev) + 1) % RATES.length] ?? 1);
  };

  const total = dur || 0;
  const pct = total > 0 ? Math.min(100, (now / total) * 100) : 0;
  const disabled = !hasAudio;

  return (
    <div className="player">
      <button
        type="button"
        className="play-btn"
        onClick={toggle}
        disabled={disabled}
        aria-label={playing ? '暂停' : '播放'}
        title={disabled ? '还没有可播放的录音' : (playing ? '暂停' : '播放')}
      >
        {playing ? '❙❙' : '▶'}
      </button>

      <div className="prog">
        <div className="fill" style={{ width: `${pct}%` }} />
        <span className="knob" style={{ left: `${pct}%` }} />
        <input
          type="range"
          min={0}
          max={total > 0 ? total : 1}
          step={0.1}
          value={Math.min(now, total || 1)}
          disabled={disabled || !ready}
          aria-label="播放进度"
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>

      <span className="clock">{clock(now)} / {ready ? clock(total) : '--:--'}</span>

      <button
        type="button"
        className="btn btn-ghost btn-sm btn-mono"
        onClick={cycleRate}
        disabled={disabled}
        title="切换播放倍速"
      >
        {rateLabel(rate)}
      </button>

      {label && <span className="np" title={label}>{label}</span>}
    </div>
  );
}
