#!/usr/bin/env python3
"""
Treina o modelo GradientBoosting usando dados que já foram exportados como CSV
Pré-requisito: Executar query_score_data.sql no banco e salvar resultado como score_training_data.csv
"""

import pandas as pd
import numpy as np
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.model_selection import train_test_split
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix, classification_report
import pickle
import os
import sys
from datetime import datetime

print("=" * 80)
print("[>>] TREINAMENTO DO MODELO DE SCORE DE PROGRESSAO (FROM CSV)")
print(f"     Data/Hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print("=" * 80)

try:
    # Carregar dados
    input_path = "data/score_training_data.csv"
    print(f"\n[1] Carregando dados de: {input_path}")

    if not os.path.exists(input_path):
        print(f"[!] Arquivo não encontrado: {input_path}")
        print(f"\n    INSTRUCOES:")
        print(f"    1. Abra MySQL Workbench")
        print(f"    2. Cole o conteúdo de: query_score_data.sql")
        print(f"    3. Execute a query")
        print(f"    4. Clique em 'Export Recordset' (ícone na barra de resultados)")
        print(f"    5. Salve como: data/score_training_data.csv")
        print(f"    6. Rode este script novamente")
        sys.exit(1)

    df = pd.read_csv(input_path)
    print(f"[OK] {len(df)} linhas carregadas")

    # Separar features e label
    print("\n[2] Preparando features e label...")

    X = df.drop(['id_requisicao', 'avancou'], axis=1)
    y = df['avancou']

    feature_names = X.columns.tolist()
    print(f"[OK] {len(feature_names)} features: {feature_names}")
    print(f"[OK] Label distribution: {y.value_counts().to_dict()}")

    # Criar label encoders para features categoricas
    print("\n[3] Aplicando LabelEncoder para features categoricas...")
    le_tipo = LabelEncoder()
    le_subtipo = LabelEncoder()

    # Fit e transform - se valores forem 0, não precisa de encoding
    if X['id_tipo_irregularidade'].nunique() > 1:
        X['id_tipo_irregularidade'] = le_tipo.fit_transform(X['id_tipo_irregularidade'].astype(str))
        print(f"[OK] id_tipo_irregularidade: {len(le_tipo.classes_)} classes")
    else:
        print(f"[OK] id_tipo_irregularidade: apenas 1 valor único (sem encoding)")
        le_tipo = None

    if X['id_subtipo_irregularidade'].nunique() > 1:
        X['id_subtipo_irregularidade'] = le_subtipo.fit_transform(X['id_subtipo_irregularidade'].astype(str))
        print(f"[OK] id_subtipo_irregularidade: {len(le_subtipo.classes_)} classes")
    else:
        print(f"[OK] id_subtipo_irregularidade: apenas 1 valor único (sem encoding)")
        le_subtipo = None

    # Criar scaler
    print("\n[4] Normalizando features numericas...")
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    X_scaled = pd.DataFrame(X_scaled, columns=feature_names)
    print(f"[OK] StandardScaler aplicado")

    # Split train/test (80/20)
    print("\n[5] Dividindo em train/test (80/20)...")
    X_train, X_test, y_train, y_test = train_test_split(
        X_scaled, y, test_size=0.2, random_state=42, stratify=y
    )
    print(f"[OK] Train: {len(X_train)} | Test: {len(X_test)}")

    # Treinar modelo
    print("\n[6] Treinando GradientBoostingClassifier...")
    model = GradientBoostingClassifier(
        n_estimators=100,
        learning_rate=0.1,
        max_depth=5,
        random_state=42,
        verbose=0
    )
    model.fit(X_train, y_train)
    print("[OK] Modelo treinado")

    # Avaliar no conjunto de teste
    print("\n[7] Avaliando modelo...")
    y_pred = model.predict(X_test)
    y_pred_proba = model.predict_proba(X_test)

    accuracy = accuracy_score(y_test, y_pred)
    f1 = f1_score(y_test, y_pred, average='weighted')

    print(f"\n     Metricas no Test Set:")
    print(f"     - Acuracia: {accuracy:.4f} ({accuracy*100:.1f}%)")
    print(f"     - F1-Score: {f1:.4f}")

    # Matriz de confusao
    cm = confusion_matrix(y_test, y_pred)
    print(f"\n     Matriz de Confusao:")
    print(f"     {cm}")

    # Classification report
    print(f"\n     Classification Report:")
    print(classification_report(y_test, y_pred, target_names=['Nao avancou', 'Avancou']))

    # Feature importance
    print(f"\n[8] Feature Importance (Top 5):")
    feature_importance = pd.DataFrame({
        'feature': feature_names,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)

    for idx, row in feature_importance.head(5).iterrows():
        print(f"     {row['feature']}: {row['importance']:.4f}")

    # Salvar modelo e scalers
    print("\n[9] Salvando modelos...")
    os.makedirs("models", exist_ok=True)

    model_path = "models/score_model.pkl"
    scaler_path = "models/score_scaler.pkl"
    le_tipo_path = "models/score_le_tipo.pkl"
    le_subtipo_path = "models/score_le_subtipo.pkl"

    with open(model_path, 'wb') as f:
        pickle.dump(model, f)
    print(f"[OK] Modelo salvo: {model_path}")

    with open(scaler_path, 'wb') as f:
        pickle.dump(scaler, f)
    print(f"[OK] Scaler salvo: {scaler_path}")

    if le_tipo is not None:
        with open(le_tipo_path, 'wb') as f:
            pickle.dump(le_tipo, f)
        print(f"[OK] LabelEncoder (tipo) salvo: {le_tipo_path}")

    if le_subtipo is not None:
        with open(le_subtipo_path, 'wb') as f:
            pickle.dump(le_subtipo, f)
        print(f"[OK] LabelEncoder (subtipo) salvo: {le_subtipo_path}")

    # Resumo final
    print("\n" + "=" * 80)
    print("[OK] TREINAMENTO CONCLUIDO")
    print("=" * 80)
    print(f"\nModelo: {model_path}")
    print(f"Scaler: {scaler_path}")
    print(f"LabelEncoder (tipo): {le_tipo_path}")
    print(f"LabelEncoder (subtipo): {le_subtipo_path}")
    print(f"\nAcuracia: {accuracy*100:.1f}%")
    print(f"F1-Score: {f1:.4f}")
    print(f"\nProximo passo:")
    print(f"1. Reiniciar API: python api_servidor.py")
    print(f"2. Reiniciar Backend Go: cd ../.. && go run main.go")
    print(f"3. Abrir AdminPlanilha em http://localhost:5173")

except FileNotFoundError as e:
    print(f"\n[!] Arquivo não encontrado: {e}")
    sys.exit(1)

except Exception as e:
    print(f"\n[!] Erro: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
