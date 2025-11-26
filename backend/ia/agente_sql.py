import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
import re
import json
import hashlib
import shutil
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

# Importações do LangChain
try:
    from langchain_ollama import OllamaLLM
    from langchain_community.utilities import SQLDatabase
    from langchain_community.tools.sql_database.tool import QuerySQLDatabaseTool
    from langchain_core.prompts import PromptTemplate, FewShotPromptTemplate
    from langchain_core.runnables import RunnablePassthrough
    from langchain_core.output_parsers import StrOutputParser
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False
    print("LangChain nao esta disponivel. Usando modo basico.")

class AdvancedSQLAgent:
    def __init__(self):
        self.db = None
        self.llm = None
        self.query_tool = None
        self.cache_dir = "./.sql_cache"
        self.history_file = "./.query_history.json"
        self.setup_environment()
        self.setup_cache()
        self.initialize_components()
        
    def setup_environment(self):
        """Configura variáveis de ambiente e verifica conexão"""
        required_vars = ["DB_CONSULTA_USER", "DB_CONSULTA_PASS", 
                        "DB_CONSULTA_HOST", "DB_CONSULTA_PORT", "DB_CONSULTA_NAME"]
        
        missing_vars = [var for var in required_vars if not os.getenv(var)]
        if missing_vars:
            print(f"Erro: Variaveis de ambiente faltando: {', '.join(missing_vars)}")
            sys.exit(1)
            
        self.db_uri = f"mysql+mysqldb://{os.getenv('DB_CONSULTA_USER')}:{os.getenv('DB_CONSULTA_PASS')}@{os.getenv('DB_CONSULTA_HOST')}:{os.getenv('DB_CONSULTA_PORT')}/{os.getenv('DB_CONSULTA_NAME')}"
    
    def setup_cache(self):
        """Configura sistema de cache"""
        os.makedirs(self.cache_dir, exist_ok=True)
        if not os.path.exists(self.history_file):
            with open(self.history_file, 'w') as f:
                json.dump({"queries": []}, f)
    
    def clear_cache(self):
        """Limpa todo o cache"""
        try:
            if os.path.exists(self.cache_dir):
                shutil.rmtree(self.cache_dir)
                os.makedirs(self.cache_dir)
                print("Cache limpo com sucesso!")
            else:
                print("Nenhum cache para limpar.")
        except Exception as e:
            print(f"Erro ao limpar cache: {e}")
    
    def initialize_components(self):
        """Inicializa componentes do sistema"""
        try:
            # Conexão direta com SQLAlchemy (sempre disponível)
            self.engine = create_engine(self.db_uri)
            
            if LANGCHAIN_AVAILABLE:
                self.db = SQLDatabase.from_uri(self.db_uri)
                self.llm = OllamaLLM(
                    model="llama3:8b",
                    temperature=0.1,
                    top_p=0.9,
                    num_predict=1000
                )
                # CORREÇÃO: Usando o nome correto da classe
                self.query_tool = QuerySQLDatabaseTool(db=self.db)
            else:
                print("Modo basico ativado (sem LangChain)")
                
        except Exception as e:
            print(f"Erro ao inicializar componentes: {e}")
            sys.exit(1)
    
    def get_cache_key(self, question: str) -> str:
        """Gera chave única para cache baseada na pergunta"""
        return hashlib.md5(question.encode()).hexdigest()
    
    def check_cache(self, question: str) -> Optional[str]:
        """Verifica se a consulta está em cache"""
        cache_key = self.get_cache_key(question)
        cache_file = os.path.join(self.cache_dir, f"{cache_key}.json")
        
        if os.path.exists(cache_file):
            with open(cache_file, 'r', encoding='utf-8') as f:
                cached_data = json.load(f)
                # Verifica se o cache é recente (menos de 24 horas)
                cache_time = datetime.fromisoformat(cached_data['timestamp'])
                if (datetime.now() - cache_time).total_seconds() < 86400:
                    return cached_data['sql_query']
        return None
    
    def save_to_cache(self, question: str, sql_query: str):
        """Salva consulta no cache"""
        cache_key = self.get_cache_key(question)
        cache_file = os.path.join(self.cache_dir, f"{cache_key}.json")
        
        cache_data = {
            'timestamp': datetime.now().isoformat(),
            'question': question,
            'sql_query': sql_query
        }
        
        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(cache_data, f, ensure_ascii=False, indent=2)
    
    def log_query(self, question: str, sql_query: str, success: bool, result: str = None, error: str = None):
        """Registra consulta no histórico"""
        try:
            with open(self.history_file, 'r+', encoding='utf-8') as f:
                history = json.load(f)
                history['queries'].append({
                    'timestamp': datetime.now().isoformat(),
                    'question': question,
                    'sql_query': sql_query,
                    'success': success,
                    'result': result,
                    'error': error
                })
                f.seek(0)
                json.dump(history, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Erro ao salvar historico: {e}")
    
    def get_table_info(self) -> Dict:
        """Obtém informações sobre as tabelas do banco"""
        tables_info = {}
        try:
            with self.engine.connect() as conn:
                # Obtém lista de tabelas
                result = conn.execute(text("""
                    SELECT TABLE_NAME, TABLE_COMMENT 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_SCHEMA = DATABASE()
                """))
                
                for table_name, table_comment in result:
                    # Obtém colunas de cada tabela
                    columns_result = conn.execute(text(f"""
                        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_COMMENT
                        FROM INFORMATION_SCHEMA.COLUMNS 
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table_name}'
                        ORDER BY ORDINAL_POSITION
                    """))
                    
                    columns = []
                    for col_name, data_type, is_nullable, col_comment in columns_result:
                        columns.append({
                            'name': col_name,
                            'type': data_type,
                            'nullable': is_nullable == 'YES',
                            'comment': col_comment
                        })
                    
                    tables_info[table_name] = {
                        'comment': table_comment,
                        'columns': columns
                    }
                    
        except Exception as e:
            print(f"Erro ao obter informacoes das tabelas: {e}")
        
        return tables_info
    
    def get_detailed_schema_info(self, max_tables: int = 15) -> str:
        """Obtém schema detalhado do banco"""
        schema_info = "ESQUEMA DO BANCO DE DADOS:\n\n"
        
        tables_info = self.get_table_info()
        
        # Tabelas prioritárias
        priority_tables = ['DM_Empresa', 'DM_UC', 'Fato_Faturas_Produtividade', 
                          'DM_Concessionaria', 'DM_UC_Endereco']
        
        # Ordena tabelas: prioritárias primeiro
        tables_to_show = []
        for table in priority_tables:
            if table in tables_info:
                tables_to_show.append(table)
        
        # Adiciona outras tabelas
        other_tables = [t for t in tables_info.keys() if t not in priority_tables]
        tables_to_show.extend(other_tables[:max_tables - len(tables_to_show)])
        
        for table_name in tables_to_show:
            table_data = tables_info[table_name]
            schema_info += f"TABELA: {table_name}\n"
            if table_data['comment']:
                schema_info += f"   COMENTARIO: {table_data['comment']}\n"
            
            schema_info += "   COLUNAS:\n"
            for column in table_data['columns']:
                schema_info += f"   - {column['name']} ({column['type']})"
                if column['comment']:
                    schema_info += f" - {column['comment']}"
                schema_info += "\n"
            
            schema_info += "\n" + "-" * 60 + "\n\n"
        
        return schema_info
    
    def format_sql(self, sql_query: str) -> str:
        """Formata SQL para melhor legibilidade"""
        # Remove múltiplos espaços
        sql_query = re.sub(r'\s+', ' ', sql_query).strip()
        
        # Adiciona quebras de linha após palavras-chave
        keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 
                   'INNER JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT']
        
        for keyword in keywords:
            sql_query = re.sub(fr'({keyword})\s+', fr'\1\n    ', sql_query, flags=re.IGNORECASE)
        
        return sql_query
    
    def validate_sql(self, sql_query: str) -> Tuple[bool, str]:
        """Valida a sintaxe SQL e verifica se é segura"""
        try:
            # Verifica se é uma instrução SELECT
            if not re.match(r'^\s*SELECT', sql_query, re.IGNORECASE):
                return False, "Apenas consultas SELECT sao permitidas"
            
            # Verifica por operações perigosas
            dangerous_patterns = [
                r'DROP\s+TABLE', r'DELETE\s+FROM', r'UPDATE\s+\w+SET',
                r'INSERT\s+INTO', r'TRUNCATE\s+TABLE', r'EXEC\s+',
                r'EXECUTE\s+', r';\s*--', r'/\*.*\*/', r'UNION\s+SELECT',
                r'LOAD_FILE', r'OUTFILE', r'DUMPFILE', r'INTO\s+OUTFILE'
            ]
            
            for pattern in dangerous_patterns:
                if re.search(pattern, sql_query, re.IGNORECASE):
                    return False, f"Operacao nao permitida detectada"
            
            return True, "SQL valido"
            
        except Exception as e:
            return False, f"Erro na validacao: {str(e)}"
    
    def optimize_sql(self, sql_query: str) -> str:
        """Otimiza a consulta SQL"""
        # Adiciona LIMIT se não existir
        if not re.search(r'LIMIT\s+\d+', sql_query, re.IGNORECASE):
            if re.search(r'WHERE', sql_query, re.IGNORECASE):
                sql_query += ' LIMIT 50'
            else:
                sql_query += ' LIMIT 100'
        
        # Formata o SQL
        sql_query = self.format_sql(sql_query)
        
        return sql_query
    
    def extract_sql_from_text(self, text: str) -> str:
        """Extrai SQL do texto retornado pelo LLM"""
        # Tenta encontrar blocos de código SQL
        sql_blocks = re.findall(r"```sql\n(.*?)\n```", text, re.DOTALL)
        if sql_blocks:
            return sql_blocks[0].strip()
        
        # Tenta encontrar instruções SELECT
        select_statements = re.findall(r"(SELECT.*?;)", text, re.DOTALL | re.IGNORECASE)
        if select_statements:
            return select_statements[0].strip()
        
        # Se não encontrar padrões claros, assume que é SQL puro
        return text.strip()
    
    def generate_sql_with_llm(self, question: str) -> str:
        """Gera SQL usando LLM se disponível, senão usa padrão"""
        if not LANGCHAIN_AVAILABLE:
            # Fallback: retorna consulta padrão se LLM não estiver disponível
            return f"SELECT * FROM DM_Empresa WHERE Status = 'Ativo' LIMIT 10;"
        
        try:
            schema = self.get_detailed_schema_info()
            
            prompt_template = """
            Voce e um especialista em SQL. Baseado no esquema abaixo, gere uma consulta SQL para:

            ESQUEMA:
            {schema}

            PERGUNTA: {question}

            REGRAS:
            1. Use apenas as tabelas e colunas listadas
            2. Sempre inclua LIMIT
            3. Retorne APENAS o codigo SQL
            4. Use nomes de colunas em portugues quando disponivel

            SQL:
            """
            
            prompt = PromptTemplate.from_template(prompt_template)
            chain = prompt | self.llm | StrOutputParser()
            
            response = chain.invoke({"schema": schema, "question": question})
            return self.extract_sql_from_text(response)
            
        except Exception as e:
            print(f"Erro ao gerar SQL com LLM: {e}")
            return f"SELECT * FROM DM_Empresa WHERE Status = 'Ativo' LIMIT 5;"
    
    def execute_query_direct(self, sql_query: str) -> Tuple[bool, str]:
        """Executa consulta SQL diretamente usando SQLAlchemy"""
        try:
            with self.engine.connect() as conn:
                result = conn.execute(text(sql_query))
                
                # Converte resultado para string formatada
                columns = result.keys()
                rows = result.fetchall()
                
                if not rows:
                    return True, "Nenhum resultado encontrado."
                
                # Formata como tabela
                output = []
                col_widths = [len(str(col)) for col in columns]
                
                for row in rows:
                    for i, value in enumerate(row):
                        col_widths[i] = max(col_widths[i], len(str(value)))
                
                # Header
                header = " | ".join(str(col).ljust(col_widths[i]) for i, col in enumerate(columns))
                output.append(header)
                output.append("-" * len(header))
                
                # Rows
                for row in rows:
                    row_str = " | ".join(str(value).ljust(col_widths[i]) for i, value in enumerate(row))
                    output.append(row_str)
                
                result_str = "\n".join(output)
                # Garante encoding correto
                if hasattr(result_str, 'encode'):
                    result_str = result_str.encode('utf-8', errors='replace').decode('utf-8')
                return True, result_str
                
        except Exception as e:
            error_msg = str(e)
            if hasattr(error_msg, 'encode'):
                error_msg = error_msg.encode('utf-8', errors='replace').decode('utf-8')
            return False, error_msg
    
    def execute_query(self, sql_query: str) -> Tuple[bool, str]:
        """Executa a consulta SQL usando o método disponível"""
        if LANGCHAIN_AVAILABLE:
            try:
                result = self.query_tool.invoke(sql_query)
                # CONVERTE PARA STRING COM ENCODING CORRETO
                if hasattr(result, 'encode'):
                    result = result.encode('utf-8', errors='replace').decode('utf-8')
                return True, result
            except Exception as e:
                error_msg = str(e)
                if hasattr(error_msg, 'encode'):
                    error_msg = error_msg.encode('utf-8', errors='replace').decode('utf-8')
                return False, error_msg
        else:
            return self.execute_query_direct(sql_query)
    
    def generate_humanized_response(self, question: str, sql_result: str, sql_query: str) -> str:
        """Gera resposta humanizada a partir dos resultados"""
        # Primeiro, garante encoding correto
        if hasattr(sql_result, 'encode'):
            sql_result = sql_result.encode('utf-8', errors='replace').decode('utf-8')
        
        if not LANGCHAIN_AVAILABLE:
            # Resposta melhor formatada mesmo sem LLM
            if "Nenhum resultado" in sql_result:
                return f"Para a pergunta '{question}', nao foram encontrados resultados na base de dados."
            else:
                # Tenta extrair apenas os dados relevantes
                lines = sql_result.split('\n')
                if len(lines) > 2:  # Tem cabeçalho e dados
                    data_lines = lines[2:]  # Pula cabeçalho e linha de separação
                    empresas = []
                    for line in data_lines:
                        if line.strip():
                            # Pega a primeira coluna (nome da empresa)
                            empresa = line.split('|')[0].strip() if '|' in line else line.strip()
                            if empresa and empresa not in empresas:
                                empresas.append(empresa)
                    
                    if empresas:
                        resposta = f"Foram encontradas {len(empresas)} empresas ativas:\n"
                        for i, empresa in enumerate(empresas, 1):
                            resposta += f"{i}. {empresa}\n"
                        return resposta
                
                return f"Resultados para '{question}':\n{sql_result}"
        
        try:
            humanize_template = """
            Você é um assistente que responde perguntas de forma direta.
            Use o resultado da consulta para responder à pergunta original de forma objetiva e em uma única frase.
            Não adicione informações extras, contexto ou explicações. Apenas a resposta direta.

            EXEMPLO:
            Pergunta Original: qual a razão social da empresa com cod 10
            Resultado da Consulta: [('GRUPO PÃO DE AÇÚCAR',)]
            Resposta Direta: A razão social da empresa com código 10 é GRUPO PÃO DE AÇÚCAR.

            TAREFA:
            Pergunta Original: {question}
            Resultado da Consulta: {result}
            Resposta Direta:
            """
            
            prompt = PromptTemplate.from_template(humanize_template)
            chain = prompt | self.llm | StrOutputParser()
            
            response = chain.invoke({
                "question": question,
                "result": sql_result
            })
            
            # Garante encoding correto na resposta final
            if hasattr(response, 'encode'):
                response = response.encode('utf-8', errors='replace').decode('utf-8')
            
            return response
            
        except Exception as e:
            # Fallback para resposta simples
            return f"Consulta executada com sucesso. {len(sql_result.splitlines())} linhas retornadas."

    def process_query(self, question: str):
        """Processa uma consulta completa"""
        #print(f"Processando: {question}\n")
        
        # Verifica cache primeiro
        cached_sql = self.check_cache(question)
        if cached_sql:
            #print("Usando consulta em cache...")
            sql_query = cached_sql
        else:
            # Gera nova consulta
            sql_query = self.generate_sql_with_llm(question)
            
            # Valida e otimiza a consulta
            is_valid, validation_msg = self.validate_sql(sql_query)
            if not is_valid:
                #print(f"SQL invalido: {validation_msg}")
                self.log_query(question, sql_query, False, error=validation_msg)
                return
            
            sql_query = self.optimize_sql(sql_query)
            self.save_to_cache(question, sql_query)
        
        #print(f"SQL Gerado:\n{sql_query}\n")
        
        # Executa a consulta
        success, result = self.execute_query(sql_query)
        
        if success:
            #print("Resultados obtidos com sucesso!")
            
            # Gera resposta humanizada
            human_response = self.generate_humanized_response(question, result, sql_query)
            print(f"\nResposta:\n{human_response}")
            
            # Log de sucesso
            self.log_query(question, sql_query, True, result[:500] + "..." if len(result) > 500 else result)
        else:
            print(f"Erro na execucao: {result}")
            self.log_query(question, sql_query, False, error=result)
    
    def show_query_history(self, limit: int = 10):
        """Mostra histórico de consultas"""
        try:
            with open(self.history_file, 'r', encoding='utf-8') as f:
                history = json.load(f)
                
            print("Historico de Consultas:\n")
            for i, query in enumerate(history['queries'][-limit:], 1):
                status = "SUCESSO" if query['success'] else "ERRO"
                timestamp = datetime.fromisoformat(query['timestamp']).strftime("%d/%m/%Y %H:%M")
                print(f"{i}. {status} [{timestamp}] - {query['question'][:50]}...")
                
        except Exception as e:
            print(f"Erro ao carregar historico: {e}")

def main():
    if len(sys.argv) < 2:
        print("Uso: python agente_sql.py \"sua pergunta\"")
        print("Opcoes adicionais:")
        print("  --history          Mostra historico de consultas")
        print("  --status           Mostra status do sistema")
        print("  --clear-cache      Limpa o cache de consultas")
        sys.exit(1)
    
    agent = AdvancedSQLAgent()
    
    if sys.argv[1] == "--history":
        agent.show_query_history()
    elif sys.argv[1] == "--status":
        print(f"Status do Sistema:")
        print(f"   LangChain disponivel: {'SIM' if LANGCHAIN_AVAILABLE else 'NAO'}")
        print(f"   Modo de operacao: {'Avancado' if LANGCHAIN_AVAILABLE else 'Basico'}")
    elif sys.argv[1] == "--clear-cache":
        agent.clear_cache()
    else:
        question = " ".join(sys.argv[1:])
        agent.process_query(question)

if __name__ == "__main__":
    main()