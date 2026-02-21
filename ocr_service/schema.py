import json
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, ValidationError


class InterpretedStatus(str, Enum):
    OK = "OK"
    DADOS_INSUFICIENTES = "DADOS_INSUFICIENTES"
    INVALID_JSON = "INVALID_JSON"


class EvidenceItem(BaseModel):
    text: str
    start: int
    end: int
    confidence: float = Field(ge=0.0, le=1.0)
    page_hint: Optional[int] = None


class InterpretedPayload(BaseModel):
    status: InterpretedStatus
    schema_version: str
    model_version: str
    confidence: float = Field(ge=0.0, le=1.0)
    extracted_fields: Dict[str, Any] = Field(default_factory=dict)
    missing_fields: List[str] = Field(default_factory=list)
    missing_evidence_fields: List[str] = Field(default_factory=list)
    evidence_map: Dict[str, EvidenceItem] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)


def validate_interpreted(payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        model = InterpretedPayload.model_validate(payload)
        return model.model_dump()
    except ValidationError as err:
        raise err


def schema_json() -> str:
    return json.dumps(InterpretedPayload.model_json_schema(), ensure_ascii=False)
