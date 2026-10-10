"""
CcAsr 核心 Pipeline — 解耦式架构
音频 → VAD(fsmn-vad) → 逐段 ASR(SenseVoice) + 声纹(CAM++) → 聚类 → 结构化 JSON

FunASR AutoModel 不支持 SenseVoice + SPK 原生串联 (需要 Paraformer 才有 timestamp)，
因此采用解耦方案: VAD 先切分，再分别跑 ASR 和声纹，最后对齐融合。

跨平台支持: macOS (MPS), Windows/Linux (CUDA), CPU fallback
"""

import gc
import os
import subprocess
import sys
import time
import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional, Union

import numpy as np
import soundfile as sf
import torch
import torchaudio
from funasr import AutoModel

from backend.schema import (
    Segment,
    TranscriptionResult,
    parse_sensevoice_tags,
)

logger = logging.getLogger("ccasr.pipeline")

# 声纹 embedding 最短时长 (秒), 低于此值跳过声纹提取
MIN_SPK_DURATION_S = 0.5


def _detect_device(requested: str = "auto") -> str:
    """
    自动检测最佳设备, 优先级: CUDA → MPS → CPU

    - CUDA (Windows/Linux NVIDIA GPU) → 单线程, GPU 加速
    - MPS (macOS Apple Silicon) → 单线程, GPU 加速
    - CPU fallback → 多核并行

    Args:
        requested: "auto" 自动检测, 或 "cuda"/"mps"/"cpu" 指定
    """
    if requested == "auto":
        # 优先 CUDA (Windows/Linux)
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            logger.info("CUDA 可用: %s, 使用 GPU 加速", gpu_name)
            os.environ["OMP_NUM_THREADS"] = "1"
            os.environ["MKL_NUM_THREADS"] = "1"
            return "cuda"
        # 其次 MPS (macOS)
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            logger.info("MPS (Apple Silicon GPU) 可用, 使用 GPU 加速")
            os.environ["OMP_NUM_THREADS"] = "1"
            os.environ["MKL_NUM_THREADS"] = "1"
            return "mps"
        # CPU fallback
        import multiprocessing
        ncores = multiprocessing.cpu_count()
        os.environ["OMP_NUM_THREADS"] = str(ncores)
        os.environ["MKL_NUM_THREADS"] = str(ncores)
        logger.warning("无可用 GPU, 回退到 CPU (%d 核)", ncores)
        return "cpu"

    # 用户指定了具体设备
    if requested == "cuda" and not torch.cuda.is_available():
        logger.warning("请求 CUDA 但不可用, 自动降级")
        return _detect_device("auto")
    if requested == "mps":
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            os.environ["OMP_NUM_THREADS"] = "1"
            os.environ["MKL_NUM_THREADS"] = "1"
            return "mps"
        logger.warning("请求 MPS 但不可用, 自动降级")
        return _detect_device("auto")

    return requested


def _ensure_wav(audio_path: Path) -> Path:
    """
    非 WAV 格式预转码为 16kHz 单声道 WAV,
    消除 torchaudio 运行时解码 m4a/mp3 的 CPU 开销
    """
    if audio_path.suffix.lower() == ".wav":
        return audio_path

    # 不指定 dir — 使用系统临时目录（跨平台兼容）
    wav_path = Path(tempfile.mktemp(suffix=".wav", prefix="ccasr_conv_"))
    logger.info("Converting %s → WAV (16kHz mono)...", audio_path.name)
    t0 = time.time()

    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(audio_path),
            "-ar", "16000", "-ac", "1",
            "-loglevel", "error",
            str(wav_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 转码失败: {result.stderr}")

    elapsed = time.time() - t0
    size_mb = wav_path.stat().st_size / 1024 / 1024
    logger.info("转码完成: %.1fMB, %.1fs", size_mb, elapsed)
    return wav_path


def _load_wav_sf(wav_path: Union[str, Path]) -> tuple[torch.Tensor, int]:
    """
    用 soundfile 读取 WAV 并返回 (waveform[C, T], sample_rate)。

    torchaudio 2.11+ 的 load/save 依赖 torchcodec（Windows 无官方 wheel），
    本项目音频经 _ensure_wav 统一为 WAV，soundfile 读写完全够用且跨平台稳定。
    """
    data, sr = sf.read(str(wav_path), dtype="float32", always_2d=True)  # [T, C]
    wav = torch.from_numpy(data.T)  # [C, T]
    return wav, sr


class ASRPipeline:
    """FunASR 解耦式多模型级联 Pipeline"""

    def __init__(
        self,
        device: str = "auto",
        max_segment_time: int = 30000,
        disable_update: bool = True,
    ):
        self.device = _detect_device(device)
        self._max_segment_time = max_segment_time
        self._disable_update = disable_update

        self._vad_model: Optional[AutoModel] = None
        self._asr_model: Optional[AutoModel] = None
        self._spk_model: Optional[AutoModel] = None

        # 仅当 transcribe(return_embeddings=True) 时填充
        self.last_embeddings: Optional[list[np.ndarray]] = None
        self.last_segment_durations: Optional[list[float]] = None

    def load(self) -> None:
        """加载三个模型 (首次较慢, 约 30-60s, 后续走缓存)"""
        if self._vad_model is not None:
            return

        logger.info("Loading models on device=%s ...", self.device)
        t0 = time.time()

        logger.info("  Loading VAD (fsmn-vad)...")
        self._vad_model = AutoModel(
            model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": self._max_segment_time},
            device=self.device,
            disable_update=self._disable_update,
            trust_remote_code=True,
        )

        logger.info("  Loading ASR (SenseVoiceSmall)...")
        self._asr_model = AutoModel(
            model="iic/SenseVoiceSmall",
            device=self.device,
            disable_update=self._disable_update,
            trust_remote_code=True,
        )

        logger.info("  Loading Speaker (CAM++)...")
        self._spk_model = AutoModel(
            model="cam++",
            device=self.device,
            disable_update=self._disable_update,
            trust_remote_code=True,
        )

        logger.info("All models loaded in %.1fs", time.time() - t0)

    @property
    def is_loaded(self) -> bool:
        return self._vad_model is not None

    def _release_memory(self) -> None:
        """释放 GPU + CPU 缓存，防止内存持续增长"""
        import ctypes, ctypes.util
        # GPU 缓存
        if self.device == "mps":
            if hasattr(torch.mps, "empty_cache"):
                torch.mps.empty_cache()
        elif self.device == "cuda":
            torch.cuda.empty_cache()
        # Python GC（多轮确保循环引用被回收）
        for _ in range(3):
            gc.collect()
        # macOS: 强制 malloc 释放空闲内存回系统
        try:
            libc = ctypes.CDLL(ctypes.util.find_library("c"))
            libc.malloc_zone_pressure_relief(None, 0)
        except Exception:
            pass

    def transcribe(
        self,
        audio_path: Union[str, Path],
        language: str = "zh",
        batch_size_s: int = 1200,
        return_embeddings: bool = False,
    ) -> TranscriptionResult:
        """
        转写音频文件, 返回结构化结果

        Args:
            audio_path: 音频文件路径 (支持 wav/mp3/m4a/flac)
            language: 语种 (auto/zh/en/yue/ja/ko)
            batch_size_s: ASR 批处理秒数 (大内存可拉高到 1200+)
            return_embeddings: 为 True 时把声纹向量暂存到
                ``self.last_embeddings`` / ``self.last_segment_durations``，
                供**项目级跨录音说话人统一**使用（多段录音拼接成同一会议时，
                各段独立聚类会导致同一个人在不同录音里 ID 不同）

        Returns:
            TranscriptionResult
        """
        self.last_embeddings = None
        self.last_segment_durations = None
        self.load()
        audio_path = Path(audio_path)
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        logger.info("Transcribing: %s (language=%s, batch=%ds)", audio_path.name, language, batch_size_s)
        t0 = time.time()

        # Step 0: 非 WAV 预转码
        wav_path = _ensure_wav(audio_path)
        converted = wav_path != audio_path

        try:
            # Step 1: VAD 切分
            segments_ms = self._run_vad(wav_path)
            total = len(segments_ms)
            logger.info("VAD found %d segments", total)

            if total == 0:
                logger.warning("No speech segments found")
                peaks = self._generate_peaks(wav_path)
                return TranscriptionResult(
                    audio_file=audio_path.name,
                    duration=0.0,
                    num_speakers=0,
                    segments=[],
                    peaks=peaks,
                )

            # 加载音频
            wav, sr = self._load_audio(wav_path)

            # Step 2: 逐段 ASR + 声纹提取 (并行)
            raw_segments = []
            embeddings = []
            t_seg = time.time()
            _executor = ThreadPoolExecutor(max_workers=2)

            for i, (start_ms, end_ms) in enumerate(segments_ms):
                chunk_path = self._extract_chunk(wav, sr, start_ms, end_ms, i)

                # 声纹时长判断
                duration_s = (end_ms - start_ms) / 1000.0
                need_spk = duration_s >= MIN_SPK_DURATION_S

                # ASR + 声纹 并行提交
                future_asr = _executor.submit(self._run_asr, chunk_path, language, batch_size_s)
                future_spk = _executor.submit(self._run_speaker_embedding, chunk_path) if need_spk else None

                # 等待结果
                text_raw = future_asr.result()
                tags = parse_sensevoice_tags(text_raw)
                emb = future_spk.result() if future_spk is not None else None

                raw_segments.append({
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "duration_s": duration_s,   # 供项目级聚类过滤过短片段
                    "tags": tags,
                    "emb_idx": len(embeddings) if emb is not None else None,
                })
                if emb is not None:
                    embeddings.append(emb)

                # 清理临时文件 (Windows 兼容: 忽略 PermissionError)
                try:
                    os.unlink(chunk_path)
                except PermissionError:
                    logger.debug("Could not delete temp file (locked): %s", chunk_path)
                except OSError:
                    pass

                # 进度日志 (每 50 段或最后一段)
                if (i + 1) % 50 == 0 or i == total - 1:
                    elapsed_s = time.time() - t_seg
                    rtf = elapsed_s / (segments_ms[i][1] / 1000.0) if segments_ms[i][1] > 0 else 0
                    logger.info(
                        "  [%d/%d] %d%% | %.1fs elapsed | RTF=%.3f | last: %.20s",
                        i + 1, total,
                        int((i + 1) / total * 100),
                        elapsed_s, rtf,
                        tags["text"][:20],
                    )

            _executor.shutdown(wait=False)

            # 释放音频 tensor (GPU 内存大户)
            del wav
            gc.collect()

            # Step 3: 声纹聚类
            logger.info("Clustering %d speaker embeddings...", len(embeddings))
            speaker_labels = self._cluster_speakers(embeddings, len(raw_segments), raw_segments)

            # 暂存声纹向量与各段时长，供项目级跨录音统一聚类
            # （必须在 del embeddings 之前复制）
            if return_embeddings:
                self.last_embeddings = [np.asarray(e).copy() for e in embeddings]
                self.last_segment_durations = [s.get("duration_s", 0.0) for s in raw_segments]

            # 聚类完成，释放 embeddings
            del embeddings

            # Step 4: 组装最终结果
            segments = []
            for i, seg in enumerate(raw_segments):
                tags = seg["tags"]
                segments.append(Segment(
                    start=seg["start_ms"] / 1000.0,
                    end=seg["end_ms"] / 1000.0,
                    text=tags["text"],
                    raw_text=tags["raw_text"],
                    speaker=speaker_labels[i],
                    emotion=tags["emotion"],
                    language=tags["language"],
                    events=tags["events"],
                ))

            duration = segments[-1].end if segments else 0.0
            speakers = set(s.speaker for s in segments)

            # Step 5: 生成波形峰值数据
            peaks = self._generate_peaks(wav_path)

            elapsed = time.time() - t0
            logger.info(
                "Done in %.1fs (%.1fx real-time): %d segments, %d speakers, %d peaks",
                elapsed, duration / elapsed if elapsed > 0 else 0,
                len(segments), len(speakers), len(peaks),
            )

            return TranscriptionResult(
                audio_file=audio_path.name,
                duration=duration,
                num_speakers=len(speakers),
                segments=segments,
                peaks=peaks,
            )

        finally:
            # 清理转码临时文件
            if converted and wav_path.exists():
                try:
                    wav_path.unlink()
                except PermissionError:
                    logger.debug("Could not delete converted WAV (locked): %s", wav_path)
            # 释放 GPU + CPU 缓存，防止内存持续增长
            self._release_memory()

    # ── 内部方法 ──────────────────────────────────────────────

    @staticmethod
    def _generate_peaks(wav_path: Path, chunk_size: int = 1024) -> list[float]:
        """
        从 WAV 文件读取音频数据, 按 chunk_size 采样点计算每段的 max 幅度值.
        返回 [float, ...] flat array, 用于前端波形绘制.
        """
        try:
            wav, sr = _load_wav_sf(wav_path)
            # 取第一个声道
            samples = wav[0].numpy()
            peaks = []
            for i in range(0, len(samples), chunk_size):
                chunk = samples[i:i + chunk_size]
                if len(chunk) == 0:
                    break
                peaks.append(float(abs(chunk).max()))
            return peaks
        except Exception as e:
            logger.warning("Failed to generate peaks: %s", e)
            return []

    def _run_vad(self, audio_path: Path) -> list[tuple[int, int]]:
        """VAD 切分, 返回 [(start_ms, end_ms), ...]"""
        res = self._vad_model.generate(input=str(audio_path), disable_pbar=True)
        if res and "value" in res[0]:
            return [tuple(seg) for seg in res[0]["value"]]
        return []

    def _load_audio(self, audio_path: Path) -> tuple[torch.Tensor, int]:
        """加载音频, 返回 (waveform, sample_rate)"""
        wav, sr = _load_wav_sf(audio_path)
        if sr != 16000:
            wav = torchaudio.transforms.Resample(sr, 16000)(wav)
            sr = 16000
        return wav, sr

    def _extract_chunk(self, wav: torch.Tensor, sr: int,
                       start_ms: int, end_ms: int, idx: int) -> str:
        """提取音频片段并保存为临时 wav 文件"""
        start_sample = int(start_ms / 1000 * sr)
        end_sample = int(end_ms / 1000 * sr)
        chunk = wav[:, start_sample:end_sample]
        # 不指定 dir — 使用系统临时目录（跨平台兼容）
        tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=".wav", prefix=f"ccasr_{idx}_"
        )
        sf.write(tmp.name, chunk.numpy().T, sr)  # [C, T] → [T, C]
        tmp.close()
        return tmp.name

    def _run_asr(self, chunk_path: str, language: str, batch_size_s: int = 1200) -> str:
        """SenseVoice ASR 推理, 返回原始文本 (含标签)"""
        res = self._asr_model.generate(
            input=chunk_path,
            language=language,
            use_itn=False,
            ban_emo_unk=False,
            batch_size_s=batch_size_s,
            disable_pbar=True,
        )
        if res and "text" in res[0]:
            return res[0]["text"]
        return ""

    def _run_speaker_embedding(self, chunk_path: str) -> Optional[np.ndarray]:
        """CAM++ 声纹特征提取, 返回 embedding ndarray"""
        try:
            res = self._spk_model.generate(input=chunk_path, disable_pbar=True)
            if res and "spk_embedding" in res[0]:
                emb = res[0]["spk_embedding"]
                if isinstance(emb, torch.Tensor):
                    emb = emb.cpu().numpy()
                return emb
        except Exception as e:
            logger.warning("Speaker embedding failed for chunk: %s", e)
        return None

    @staticmethod
    def cluster_embeddings(
        embeddings: list,
        max_speakers: int = 10,
    ) -> list[str]:
        """
        对一组声纹向量做聚类, 返回与输入等长的 speaker label 列表。

        供**项目级跨录音统一聚类**复用（多段录音拼成同一会议时，
        各段独立聚类会把同一个人编成不同 ID）。
        与 ``_cluster_speakers`` 使用完全相同的算法，保证结果口径一致。
        """
        n = len(embeddings)
        if n < 2:
            return ["SPEAKER_0"] * n

        from sklearn.cluster import SpectralClustering
        from sklearn.metrics.pairwise import cosine_similarity

        X = np.vstack([np.asarray(e).reshape(-1) for e in embeddings]).astype(np.float64)
        if not np.isfinite(X).all():
            X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
        norms = np.linalg.norm(X, axis=1, keepdims=True)
        X = X / np.maximum(norms, 1e-12)

        affinity = (cosine_similarity(X) + 1.0) / 2.0
        np.fill_diagonal(affinity, 1.0)

        k = ASRPipeline._estimate_speaker_count(affinity, max_speakers)
        labels = SpectralClustering(
            n_clusters=k, affinity="precomputed", random_state=42
        ).fit_predict(affinity)
        return [f"SPEAKER_{int(c)}" for c in labels]

    @staticmethod
    def _cluster_speakers_static(
        embeddings: list[np.ndarray],
        num_segments: int,
        raw_segments: list[dict],
        max_speakers: int = 10,
    ) -> list[str]:
        """
        与 ``_cluster_speakers`` 等价的无实例版本（供项目级统一聚类调用）。

        语义完全一致：返回长度 ``num_segments`` 的标签列表，
        无 embedding 的片段继承前一段的标签。
        """
        labels = ["SPEAKER_0"] * num_segments
        if len(embeddings) < 2:
            return labels

        try:
            cluster_labels = ASRPipeline.cluster_embeddings(embeddings, max_speakers)
            emb_idx = 0
            for i, seg in enumerate(raw_segments):
                if seg.get("emb_idx") is not None:
                    labels[i] = cluster_labels[emb_idx]
                    emb_idx += 1
                elif i > 0:
                    labels[i] = labels[i - 1]
        except Exception as e:
            logger.error("项目级声纹聚类失败, 降级为单一说话人: %s", e, exc_info=True)

        return labels

    @staticmethod
    def _estimate_speaker_count(affinity: np.ndarray, max_speakers: int) -> int:
        """
        用归一化 Laplacian 的**特征间隙 (eigengap)** 估计说话人数。

        特征间隙是谱聚类的经典判据, 比"轮廓系数取最大"稳得多:
        轮廓系数在声纹 embedding 的噪声长尾上会系统性偏向过分割
        (实测 217 段双人对话: eigengap 给出干净的 k=2, 轮廓系数却给出 k=3)。

        Args:
            affinity: 非负对称亲和矩阵 (n×n)
            max_speakers: 说话人上限

        Returns:
            估计的说话人数 (>= 2)
        """
        from scipy.sparse.csgraph import laplacian as csgraph_laplacian
        from scipy.sparse.linalg import eigsh

        n = affinity.shape[0]
        # ARPACK 要求 k < n; 同时留出余量避免退化
        k_max = max(2, min(max_speakers, n // 4))
        k_max = min(k_max, n - 2)

        if k_max < 3:
            # 样本太少, 没有可靠的间隙可判, 退化为 2
            return 2

        # 对称化 + 置零对角线 (归一化 Laplacian 要求零对角)
        A = (affinity + affinity.T) / 2.0
        np.fill_diagonal(A, 0.0)

        lap = csgraph_laplacian(A, normed=True)
        lap = lap.toarray() if hasattr(lap, "toarray") else np.asarray(lap)

        # n_components = k_max + 1 → 需要 λ0..λ_kmax; k 必须 < n 且 < n-1
        n_components = min(k_max + 1, n - 1)
        try:
            eigvals = eigsh(lap, k=n_components, which="SM",
                            return_eigenvectors=False, tol=1e-7, maxiter=5000)
        except Exception as e:
            logger.warning("特征值求解失败, 退化为 2 个说话人: %s", e)
            return 2

        # 归一化 Laplacian 的最小特征值恒为 0。
        # ARPACK 通常已经返回了它，直接 append 会产生**重复的 0**，
        # 使整个谱右移一位、所有间隙下标失效（实测会把 3 簇误判为 2 簇）。
        # 因此仅在确实缺失时才补 0。
        eigvals = np.sort(np.asarray(eigvals, dtype=float))
        if eigvals.size == 0 or eigvals[0] > 1e-8:
            eigvals = np.concatenate(([0.0], eigvals))
        eigvals = eigvals[:k_max + 1]
        gaps = np.diff(eigvals)

        # eigengap 判据：k = (最大间隙在 gaps 中的下标) + 1
        #
        # 必须跳过 gaps[0] = λ1 - λ0：λ0 恒为 0，图连通时 λ1 明显大于 0，
        # 该间隙永远最大（实测合成数据 0.86 vs 次大 0.15），
        # 不跳过就会把任何数据都判成 k=1。
        #
        # 下标换算：argmax 返回的是「切片 gaps[1:] 内」的下标，
        # 还原到 gaps 需 +1，再因 k = gap_index + 1，合计 +2。
        #
        # 实测校准：
        #   合成 3 簇: λ=[0,.86,.90,1.05,..] gaps=[.86,.041,.15,..]
        #              → argmax(gaps[1:])=1 → k=3 ✅
        #   合成 2 簇: gaps=[.785,.275,.001,..] → argmax=0 → k=2 ✅
        #   真实双人对话: gaps=[.918,.044,.025,..] → argmax=0 → k=2 ✅
        k = int(np.argmax(gaps[1:])) + 2
        k = max(2, min(k, k_max))
        logger.debug("eigengap 判据: λ=%s, gaps=%s → k=%d",
                     np.round(eigvals, 4).tolist(), np.round(gaps, 4).tolist(), k)
        return k

    def _cluster_speakers(
        self,
        embeddings: list[np.ndarray],
        num_segments: int,
        raw_segments: list[dict],
        max_speakers: int = 10,
    ) -> list[str]:
        """
        对声纹 embeddings 进行谱聚类, 返回每个 segment 的 speaker label。

        关键实现约束: **亲和矩阵必须非负**。
        余弦相似度天然含负值, 若直接以 affinity="cosine" 交给 sklearn,
        亲和矩阵非 PSD 会让"度"(行和)出现负值, 归一化 Laplacian 计算
        1/sqrt(度) 时产生 NaN, 聚类整体失败并静默回落为单一说话人。
        因此这里显式把余弦相似度线性映射到 [0,1] 后以 precomputed 传入。

        如果 embedding 不足 2 个, 默认全部为 SPEAKER_0
        """
        labels = ["SPEAKER_0"] * num_segments

        if len(embeddings) < 2:
            return labels

        try:
            from sklearn.cluster import SpectralClustering
            from sklearn.metrics.pairwise import cosine_similarity

            # 构建 embedding 矩阵 (展平为 [n, dim])
            X = np.vstack([np.asarray(e).reshape(-1) for e in embeddings]).astype(np.float64)

            # 清理异常值再归一化: 防止零范数/NaN 影响亲和矩阵
            if not np.isfinite(X).all():
                bad = int((~np.isfinite(X)).sum())
                logger.warning("声纹 embedding 含 %d 个非有限值, 已置零", bad)
                X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)

            # L2 归一化 (CAM++ 声纹标准做法): 消除 embedding 幅度差异
            norms = np.linalg.norm(X, axis=1, keepdims=True)
            X = X / np.maximum(norms, 1e-12)

            # 余弦相似度 → [0,1] 非负亲和矩阵; 负值映射到 0 附近, 保证度为正
            affinity = (cosine_similarity(X) + 1.0) / 2.0
            np.fill_diagonal(affinity, 1.0)

            best_n = self._estimate_speaker_count(affinity, max_speakers)
            clustering = SpectralClustering(
                n_clusters=best_n, affinity="precomputed", random_state=42
            )
            cluster_labels = clustering.fit_predict(affinity)

            # 将聚类结果映射回 segments
            emb_idx = 0
            for i, seg in enumerate(raw_segments):
                if seg["emb_idx"] is not None:
                    labels[i] = f"SPEAKER_{cluster_labels[emb_idx]}"
                    emb_idx += 1
                else:
                    # 太短没有 embedding 的片段, 使用前一个 segment 的 speaker
                    if i > 0:
                        labels[i] = labels[i - 1]

            counts = np.bincount(cluster_labels, minlength=best_n)
            logger.info("声纹聚类完成: k=%d, 各簇段数=%s", best_n, counts.tolist())

        except Exception as e:
            # 不再静默: 这是曾导致"永远只有 1 个说话人"的隐藏故障点
            logger.error("声纹聚类失败, 已降级为单一说话人 (SPEAKER_0): %s",
                         e, exc_info=True)

        return labels


# 全局单例
_pipeline: Optional[ASRPipeline] = None


def get_pipeline(device: str = "auto") -> ASRPipeline:
    """获取全局 Pipeline 单例"""
    global _pipeline
    if _pipeline is None:
        _pipeline = ASRPipeline(device=device)
    return _pipeline
