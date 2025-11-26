#!/usr/bin/env python3
"""
Script para instalar dependências do Agente SQL Avançado
"""

import subprocess
import sys

def run_command(command):
    """Executa um comando e retorna o resultado"""
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        return result.returncode == 0, result.stdout, result.stderr
    except Exception as e:
        return False, "", str(e)

def main():
    print("🔧 Instalando dependências do Agente SQL Avançado...\n")
    
    # Dependências principais
    dependencies = [
        "langchain-ollama",
        "langchain-community", 
        "langchain-core",
        "sqlalchemy",
        "mysql-connector-python"
    ]
    
    # Dependências opcionais
    optional_deps = [
        "sqlparse"  # Para formatação avançada de SQL
    ]
    
    print("📦 Instalando dependências principais...")
    for dep in dependencies:
        print(f"   Instalando {dep}...")
        success, stdout, stderr = run_command(f"pip install {dep}")
        if success:
            print(f"   ✅ {dep} instalado com sucesso")
        else:
            print(f"   ⚠️  Erro ao instalar {dep}: {stderr}")
    
    print("\n📦 Instalando dependências opcionais...")
    for dep in optional_deps:
        print(f"   Instalando {dep}...")
        success, stdout, stderr = run_command(f"pip install {dep}")
        if success:
            print(f"   ✅ {dep} instalado com sucesso")
        else:
            print(f"   ⚠️  {dep} não pôde ser instalado: {stderr}")
    
    print("\n🎉 Instalação concluída!")
    print("\n💡 Dica: Configure suas variáveis de ambiente:")
    print("   export DB_CONSULTA_USER=seu_usuario")
    print("   export DB_CONSULTA_PASS=sua_senha")
    print("   export DB_CONSULTA_HOST=localhost")
    print("   export DB_CONSULTA_PORT=3306")
    print("   export DB_CONSULTA_NAME=seu_banco")

if __name__ == "__main__":
    main()