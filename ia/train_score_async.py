#!/usr/bin/env python3
"""
Script para treinar Score model de forma assíncrona
"""

import mysql.connector
import pandas as pd
import numpy as np
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.model_selection import train_test_split
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score, f1_score, roc_auc_score,
    confusion_matrix, classification_report
)
import pickle
import os
import sys
from datetime import datetime
import re
import logging

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

def load_env(filepath):
    if os.path.exists(filepath):
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip()

env_path = os.path.join(os.path.dirname(__file__), '..', 'backend', '.env')
load_env(env_path)

DB_HOST = DB_USER = DB_PASS = DB_NAME = None

DB_APP_URL = os.getenv("DB_APP_URL", "")
if DB_APP_URL:
    match = re.match(r'([^:]+):([^@]+)@tcp\(([^:]+):(\d+)\)/(.+)', DB_APP_URL)
    if match:
        DB_USER = match.group(1)
        DB_PASS = match.group(2)
        DB_HOST = match.group(3)
        DB_NAME = match.group(5)
        logger.info(f"[*] Usando DB_APP_URL: {DB_HOST}")

if not DB_HOST:
    DB_HOST = os.getenv("DB_HOST", "db")
if not DB_USER:
    DB_USER = os.getenv("DB_USER") or ""
if not DB_PASS:
    DB_PASS = os.getenv("DB_PASS") or ""
if not DB_NAME:
    DB_NAME = os.getenv("DB_NAME") or ""

if not DB_USER or not DB_PASS or not DB_NAME:
    logger.error("Credenciais de banco não configuradas (DB_USER, DB_PASS, DB_NAME)")
    sys.exit(1)

logger.info(f"[*] Conectando a {DB_HOST}:{DB_NAME}...")


def extract_score_data_from_db():
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASS,
            database=DB_NAME,
            autocommit=True,
            connection_timeout=30
        )
        cursor = conn.cursor()

        # Usa a view vw_score_progressao (criada via query_score_data.sql)
        query = "SELECT * FROM vw_score_progressao LIMIT 100000"

        cursor.execute(query)
        rows = cursor.fetchall()
        columns = [desc[0] for desc in cursor.description]
        conn.close()

        df = pd.DataFrame(rows, columns=columns)
        # Remove duplicatas por id_requisicao
        df = df.drop_duplicates(subset=['id_requisicao'])
        # Remove linhas com NaN
        df = df.dropna()
        return df

    except Exception as e:
        logger.error(f"Erro ao extrair dados: {e}")
        return None


def train_score_model(df=None):
    logger.info("=" * 80)
    logger.info("[>>] TREINAMENTO DO MODELO DE SCORE DE PROGRESSAO")
    logger.info(f"     Data/Hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info("=" * 80)

    try:
        if df is None:
            logger.info("[1] Extraindo dados do banco...")
            df = extract_score_data_from_db()
            if df is None or len(df) == 0:
                logger.error("Nenhum dado encontrado no banco")
                return False

        logger.info(f"[OK] {len(df)} linhas carregadas")

        logger.info("[2] Preparando features e label...")
        # Remove features com leakage temporal: acumulam ao longo do tempo e não refletem
        # o estado do processo quando ainda estava em Ativos.
        LEAKY = ['num_movimentacoes', 'num_anexos', 'passou_distribuidora', 'tem_periodos']
        df = df.drop(columns=[c for c in LEAKY if c in df.columns])
        X = df.drop(['id_requisicao', 'avancou'], axis=1)
        y = df['avancou']

        feature_names = X.columns.tolist()
        logger.info(f"[OK] {len(feature_names)} features: {feature_names}")

        # Verificar distribuição de classes
        class_dist = y.value_counts()
        logger.info(f"     Distribuição de classes: {class_dist.to_dict()}")
        balance = class_dist.min() / class_dist.max()
        if balance < 0.2:
            logger.warning(f"     AVISO: Dataset desbalanceado (ratio={balance:.2f}) — considere class_weight")

        # ----------------------------------------------------------------
        # [3] Split ANTES de qualquer encoding — evita data leakage
        # ----------------------------------------------------------------
        logger.info("[3] Dividindo train/test ANTES de encoding e normalização...")
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y
        )

        # ----------------------------------------------------------------
        # [4] LabelEncoder apenas nos dados de treino
        # ----------------------------------------------------------------
        logger.info("[4] Aplicando LabelEncoder (fit apenas em TRAIN)...")
        le_tipo    = LabelEncoder() if X_train['id_tipo_irregularidade'].nunique() > 1 else None
        le_subtipo = LabelEncoder() if X_train['id_subtipo_irregularidade'].nunique() > 1 else None

        if le_tipo:
            X_train = X_train.copy()
            X_test  = X_test.copy()
            X_train['id_tipo_irregularidade'] = le_tipo.fit_transform(
                X_train['id_tipo_irregularidade'].astype(str)
            )
            X_test['id_tipo_irregularidade'] = X_test['id_tipo_irregularidade'].astype(str).map(
                lambda v: le_tipo.transform([v])[0] if v in le_tipo.classes_ else 0
            )
        if le_subtipo:
            X_train = X_train.copy()
            X_test  = X_test.copy()
            X_train['id_subtipo_irregularidade'] = le_subtipo.fit_transform(
                X_train['id_subtipo_irregularidade'].astype(str)
            )
            X_test['id_subtipo_irregularidade'] = X_test['id_subtipo_irregularidade'].astype(str).map(
                lambda v: le_subtipo.transform([v])[0] if v in le_subtipo.classes_ else 0
            )

        logger.info("[5] Normalizando (fit apenas em TRAIN)...")
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)   # fit apenas em TRAIN
        X_test_scaled  = scaler.transform(X_test)        # aplica em TEST

        logger.info("[6] Treinando GradientBoostingClassifier...")
        model = GradientBoostingClassifier(
            n_estimators=100,
            learning_rate=0.1,
            max_depth=5,
            subsample=0.8,
            random_state=42
        )
        model.fit(X_train_scaled, y_train)

        # ----------------------------------------------------------------
        # [7] Avaliação completa
        # ----------------------------------------------------------------
        logger.info("[7] Avaliando...")
        y_pred      = model.predict(X_test_scaled)
        y_pred_prob = model.predict_proba(X_test_scaled)[:, 1]

        accuracy = accuracy_score(y_test, y_pred)
        f1       = f1_score(y_test, y_pred, average='weighted')
        roc_auc  = roc_auc_score(y_test, y_pred_prob)
        cm       = confusion_matrix(y_test, y_pred)

        logger.info(f"     Acuracia : {accuracy*100:.1f}%")
        logger.info(f"     F1-Score : {f1:.4f}")
        logger.info(f"     ROC-AUC  : {roc_auc:.4f}")
        logger.info(f"     Matriz de Confusão:")
        logger.info(f"       TN={cm[0,0]}  FP={cm[0,1]}")
        logger.info(f"       FN={cm[1,0]}  TP={cm[1,1]}")
        logger.info("\n" + classification_report(y_test, y_pred,
                    target_names=['Não avançou', 'Avançou']))

        # Feature importance
        feat_imp = pd.DataFrame({
            'feature': feature_names,
            'importance': model.feature_importances_
        }).sort_values('importance', ascending=False)
        logger.info(f"     Top features:\n{feat_imp.to_string(index=False)}")

        logger.info("[8] Salvando modelos...")
        os.makedirs("models", exist_ok=True)

        with open("models/score_model.pkl", 'wb') as f:
            pickle.dump(model, f)
        with open("models/score_scaler.pkl", 'wb') as f:
            pickle.dump(scaler, f)

        if le_tipo:
            with open("models/score_le_tipo.pkl", 'wb') as f:
                pickle.dump(le_tipo, f)
        if le_subtipo:
            with open("models/score_le_subtipo.pkl", 'wb') as f:
                pickle.dump(le_subtipo, f)

        logger.info("[OK] TREINAMENTO CONCLUIDO")
        return True

    except Exception as e:
        logger.error(f"Erro ao treinar: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    success = train_score_model()
    sys.exit(0 if success else 1)
