import json
import os
import requests
from typing import Optional


class LLMClient:
    def __init__(self):
        self.provider = (os.getenv("LLM_PROVIDER", "ollama") or "ollama").strip().lower()
        self.base_url = (os.getenv("LLM_BASE_URL") or os.getenv("LLM_OLLAMA_URL") or "http://localhost:11434").rstrip("/")
        self.model = (os.getenv("LLM_MODEL") or os.getenv("LLM_OLLAMA_MODEL") or "llama3.1:8b").strip()
        self.timeout = int(os.getenv("LLM_TIMEOUT_SECONDS", "60") or "60")

    def generate(self, prompt: str) -> Optional[str]:
        if self.provider in ("off", "none", "disabled"):
            return None
        if self.provider == "ollama":
            return self._call_ollama(prompt)
        if self.provider == "llamacpp":
            return self._call_llamacpp(prompt)
        return self._call_ollama(prompt)

    def _call_ollama(self, prompt: str) -> str:
        url = f"{self.base_url}/api/generate"
        payload = {"model": self.model, "prompt": prompt, "stream": False}
        resp = requests.post(url, json=payload, timeout=self.timeout)
        resp.raise_for_status()
        data = resp.json()
        return (data.get("response") or "").strip()

    def _call_llamacpp(self, prompt: str) -> str:
        # llama.cpp HTTP server compatibility (basic)
        url = f"{self.base_url}/completion"
        payload = {"prompt": prompt, "n_predict": 1024, "temperature": 0.1}
        resp = requests.post(url, json=payload, timeout=self.timeout)
        resp.raise_for_status()
        data = resp.json()
        return (data.get("content") or data.get("response") or "").strip()


def try_parse_json(text: str) -> Optional[dict]:
    if not text:
        return None
    try:
        start = text.find("{")
        end = text.rfind("}")
        raw = text[start : end + 1] if (start != -1 and end != -1 and end > start) else text
        return json.loads(raw)
    except Exception:
        return None
