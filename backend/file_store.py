"""CcAsr 文件管理 — MD5 去重 + 元数据持久化"""

import hashlib
import json
import os
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, List

from backend.config import get_output_dir

logger = logging.getLogger("ccasr.files")

# 文件存储目录
FILES_DIR = get_output_dir() / "files"
FILES_DIR.mkdir(parents=True, exist_ok=True)

# 元数据文件
METADATA_FILE = FILES_DIR / "metadata.json"


class FileRecord:
    """单个文件记录"""
    def __init__(self, md5: str, original_name: str, size: int, ext: str,
                 first_uploaded: str, task_ids: List[str] = None):
        self.md5 = md5
        self.original_name = original_name
        self.size = size
        self.ext = ext
        self.first_uploaded = first_uploaded
        self.task_ids: List[str] = task_ids or []

    def to_dict(self) -> dict:
        return {
            "md5": self.md5,
            "original_name": self.original_name,
            "size": self.size,
            "ext": self.ext,
            "first_uploaded": self.first_uploaded,
            "task_ids": self.task_ids,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FileRecord":
        return cls(
            md5=d["md5"],
            original_name=d["original_name"],
            size=d["size"],
            ext=d["ext"],
            first_uploaded=d["first_uploaded"],
            task_ids=d.get("task_ids", []),
        )


class FileStore:
    """文件管理器 — MD5 去重 + JSON 元数据"""

    def __init__(self):
        self._records: Dict[str, FileRecord] = {}  # md5 -> FileRecord
        self._task_file_map: Dict[str, str] = {}    # task_id -> md5
        self._load()

    def _load(self):
        """从 metadata.json 加载"""
        if not METADATA_FILE.exists():
            return
        try:
            with open(METADATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            for d in data.get("files", []):
                rec = FileRecord.from_dict(d)
                self._records[rec.md5] = rec
                for tid in rec.task_ids:
                    self._task_file_map[tid] = rec.md5
            logger.info("Loaded %d file records from metadata", len(self._records))
        except Exception as e:
            logger.warning("Failed to load metadata: %s", e)

    def _save(self):
        """持久化到 metadata.json"""
        data = {
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "files": [rec.to_dict() for rec in self._records.values()],
        }
        tmp = METADATA_FILE.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        # os.replace 跨平台原子替换 (Path.rename 在 Windows 上不覆盖已存在文件)
        os.replace(str(tmp), str(METADATA_FILE))

    def save_file(self, content: bytes, original_name: str, task_id: str) -> Path:
        """
        保存上传文件（MD5 去重）。
        返回文件路径。如果已存在则复用，不重复写入。
        """
        md5 = hashlib.md5(content).hexdigest()
        ext = Path(original_name).suffix.lower() or ".bin"
        now = datetime.now(timezone.utc).isoformat()

        if md5 in self._records:
            # 已存在 — 只关联 task_id
            rec = self._records[md5]
            if task_id not in rec.task_ids:
                rec.task_ids.append(task_id)
            self._task_file_map[task_id] = md5
            self._save()
            file_path = FILES_DIR / f"{md5}{rec.ext}"
            logger.info("[file %s] Reused (task=%s, original=%s)", md5[:8], task_id, original_name)
            return file_path

        # 新文件 — 写入磁盘
        file_path = FILES_DIR / f"{md5}{ext}"
        with open(file_path, "wb") as f:
            f.write(content)

        rec = FileRecord(
            md5=md5,
            original_name=original_name,
            size=len(content),
            ext=ext,
            first_uploaded=now,
            task_ids=[task_id],
        )
        self._records[md5] = rec
        self._task_file_map[task_id] = md5
        self._save()
        logger.info("[file %s] Saved (task=%s, original=%s, size=%d)",
                    md5[:8], task_id, original_name, len(content))
        return file_path

    def get_file_path(self, task_id: str) -> Optional[Path]:
        """根据 task_id 查找对应的音频文件路径"""
        md5 = self._task_file_map.get(task_id)
        if not md5:
            return None
        rec = self._records.get(md5)
        if not rec:
            return None
        file_path = FILES_DIR / f"{md5}{rec.ext}"
        if file_path.exists():
            return file_path
        return None

    def get_file_record(self, task_id: str) -> Optional[FileRecord]:
        """根据 task_id 获取文件记录"""
        md5 = self._task_file_map.get(task_id)
        if not md5:
            return None
        return self._records.get(md5)

    def get_original_name(self, task_id: str) -> Optional[str]:
        """获取原始文件名"""
        rec = self.get_file_record(task_id)
        return rec.original_name if rec else None

    def list_files(self) -> List[dict]:
        """列出所有文件记录"""
        return [rec.to_dict() for rec in self._records.values()]

    def cleanup_orphans(self, active_task_ids: set) -> int:
        """清理没有关联任何活跃任务的文件，返回清理数量"""
        cleaned = 0
        to_remove = []
        for md5, rec in self._records.items():
            # 移除不在活跃列表中的 task_id
            rec.task_ids = [tid for tid in rec.task_ids if tid in active_task_ids]
            if not rec.task_ids:
                # 没有关联任务了，删除文件
                file_path = FILES_DIR / f"{md5}{rec.ext}"
                if file_path.exists():
                    file_path.unlink()
                to_remove.append(md5)
                cleaned += 1
                logger.info("[file %s] Cleaned up (no linked tasks)", md5[:8])

        for md5 in to_remove:
            del self._records[md5]

        # 清理 task_file_map 中已删除的条目
        self._task_file_map = {
            tid: md5 for tid, md5 in self._task_file_map.items()
            if md5 in self._records
        }

        if cleaned > 0:
            self._save()
        return cleaned


# 全局单例
_file_store: Optional[FileStore] = None


def get_file_store() -> FileStore:
    global _file_store
    if _file_store is None:
        _file_store = FileStore()
    return _file_store
