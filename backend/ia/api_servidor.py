#!/usr/bin/env python3
"""
API FastAPI para servir Score de Progressão
Porta: 8000
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from pathlib import Path
import pickle
import math
import numpy as np
import logging

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Score de Progressão API")

# Resolve caminho absoluto independente de onde a API é executada
MODEL_DIR = Path(__file__).parent / "models"

def load_pickle(path):
    with open(path, 'rb') as f:
        return pickle.load(f)

# Carrega modelos
logger.info("[*] Carregando modelos...")
try:
    score_model  = load_pickle(MODEL_DIR / "score_model.pkl")
    score_scaler = load_pickle(MODEL_DIR / "score_scaler.pkl")
    logger.info("[OK] Score model carregado!")

    try:
        score_le_tipo = load_pickle(MODEL_DIR / "score_le_tipo.pkl")
        logger.info("[OK] LabelEncoder tipo carregado!")
    except FileNotFoundError:
        score_le_tipo = None

    try:
        score_le_subtipo = load_pickle(MODEL_DIR / "score_le_subtipo.pkl")
        logger.info("[OK] LabelEncoder subtipo carregado!")
    except FileNotFoundError:
        score_le_subtipo = None

except FileNotFoundError as e:
    logger.error(f"[!] Erro ao carregar modelos: {e}")
    logger.warning("[!] Modelos não encontrados - treine com train_score_async.py")
    score_model = score_scaler = score_le_tipo = score_le_subtipo = None


def safe_label_encode(encoder, value):
    """Encoda valor com fallback para classes desconhecidas."""
    val_str = str(int(value))
    if val_str in encoder.classes_:
        return int(encoder.transform([val_str])[0])
    logger.warning(f"Classe desconhecida no LabelEncoder: '{val_str}' — usando fallback 0")
    return 0


# ============================================================================
# MODELO: Score de Progressão
# ============================================================================

class ScoreRequest(BaseModel):
    num_movimentacoes:        int   = Field(..., ge=0, le=10000)
    num_anexos:               int   = Field(..., ge=0, le=10000)
    valor_estimado:           float = Field(..., ge=0)
    dias_em_processamento:    int   = Field(..., ge=0, le=36500)
    passou_distribuidora:     int   = Field(..., ge=0, le=1)
    id_tipo_irregularidade:   int   = Field(..., ge=0)
    id_subtipo_irregularidade:int   = Field(..., ge=0)
    tem_descricao:            int   = Field(..., ge=0, le=1)
    tem_link_fatura:          int   = Field(..., ge=0, le=1)
    tem_periodos:             int   = Field(..., ge=0, le=1)

    @validator('valor_estimado')
    def validar_valor(cls, v):
        if math.isnan(v) or math.isinf(v):
            raise ValueError('valor_estimado não pode ser NaN ou Inf')
        return v


class ScoreResponse(BaseModel):
    score:      float
    label:      str
    percentual: float
    prediction: int
    erro:       str = None


@app.get("/ping")
async def ping():
    return {"status": "ok"}


@app.post("/predict/score")
async def predict_score(request: ScoreRequest):
    """
    Prediz Score de Progressão (probabilidade de avançar de Ativos para próxima etapa).
    Returns: score (0-1), label (Alta/Média/Baixa), percentual (0-100), prediction (0 ou 1)
    """
    if score_model is None:
        raise HTTPException(status_code=503, detail="Modelo não carregado — execute train_score_async.py")

    try:
        features = np.array([[
            request.num_movimentacoes,
            request.num_anexos,
            request.valor_estimado,
            request.dias_em_processamento,
            request.passou_distribuidora,
            request.id_tipo_irregularidade,
            request.id_subtipo_irregularidade,
            request.tem_descricao,
            request.tem_link_fatura,
            request.tem_periodos
        ]], dtype=float)

        # Aplicar LabelEncoders com fallback para classes desconhecidas
        if score_le_tipo is not None:
            features[0, 5] = safe_label_encode(score_le_tipo, features[0, 5])

        if score_le_subtipo is not None:
            features[0, 6] = safe_label_encode(score_le_subtipo, features[0, 6])

        # Validar NaN/Inf antes de escalar
        if np.any(np.isnan(features)) or np.any(np.isinf(features)):
            raise ValueError("Features contêm NaN ou Inf após encoding")

        features_scaled = score_scaler.transform(features)

        prediction = score_model.predict(features_scaled)[0]
        proba      = score_model.predict_proba(features_scaled)[0]
        score      = float(proba[1])
        percentual = score * 100

        if percentual >= 70:
            label = "Alta"
        elif percentual >= 40:
            label = "Média"
        else:
            label = "Baixa"

        logger.info(f"[Score] percentual={percentual:.1f}% label={label}")

        return ScoreResponse(
            score=score,
            label=label,
            percentual=percentual,
            prediction=int(prediction)
        )

    except Exception as e:
        logger.error(f"Erro ao predizer: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/train/score")
async def trigger_retrain():
    """
    Dispara retreino do modelo de Score em background.
    O container já tem acesso ao RDS via DB_APP_URL.
    """
    import threading
    from train_score_async import train_score_model

    def run_train():
        global score_model, score_scaler, score_le_tipo, score_le_subtipo
        logger.info("[Train] Iniciando retreino em background...")
        success = train_score_model()
        if success:
            # Recarrega modelos após treino
            try:
                score_model   = load_pickle(MODEL_DIR / "score_model.pkl")
                score_scaler  = load_pickle(MODEL_DIR / "score_scaler.pkl")
                try:
                    score_le_tipo    = load_pickle(MODEL_DIR / "score_le_tipo.pkl")
                    score_le_subtipo = load_pickle(MODEL_DIR / "score_le_subtipo.pkl")
                except FileNotFoundError:
                    pass
                logger.info("[Train] Modelos recarregados com sucesso!")
            except Exception as e:
                logger.error(f"[Train] Erro ao recarregar modelos: {e}")
        else:
            logger.error("[Train] Retreino falhou!")

    thread = threading.Thread(target=run_train, daemon=True)
    thread.start()

    return {"status": "retreino iniciado", "message": "Verifique os logs para acompanhar o progresso"}


@app.get("/train/status")
async def train_status():
    """Verifica se os modelos estão carregados."""
    return {
        "model_loaded":    score_model is not None,
        "scaler_loaded":   score_scaler is not None,
        "le_tipo_loaded":  score_le_tipo is not None,
        "le_subtipo_loaded": score_le_subtipo is not None,
    }


if __name__ == "__main__":
    import uvicorn
    logger.info("Score API rodando em http://0.0.0.0:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
