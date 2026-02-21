import hashlib
import json
import os
import time
from typing import Any, Dict, Optional


class ICache:
    def get(self, key: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def set(self, key: str, value: Dict[str, Any], ttl_seconds: int) -> None:
        raise NotImplementedError


class FileCache(ICache):
    def __init__(self, base_dir: str):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)

    def _path(self, key: str) -> str:
        safe = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return os.path.join(self.base_dir, f"{safe}.json")

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        path = self._path(key)
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            ttl = int(data.get("_ttl_seconds") or 0)
            created = float(data.get("_created_at") or 0)
            if ttl > 0 and created > 0 and (time.time() - created) > ttl:
                return None
            return data.get("value")
        except Exception:
            return None

    def set(self, key: str, value: Dict[str, Any], ttl_seconds: int) -> None:
        path = self._path(key)
        data = {
            "_created_at": time.time(),
            "_ttl_seconds": int(ttl_seconds),
            "value": value,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
