// routes/etapas.js - Rotas da API para etapas e sub-etapas

/**
 * Rotas da API para gerenciar etapas e sub-etapas
 * ImplementaÀ§ão para Node.js/Express com MySQL
 */

const express = require('express');
const router = express.Router();

// Middleware de autenticaÀ§ão (assuminão que já existe)
const { authenticateToken } = require('../middleware/auth');

// ===== ROTAS PARA ETAPAS =====

/**
 * GET /api/etapas
 * Busca todas as etapas disponÀ­veis
 */
router.get('/etapas', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                id_etapa_processo,
                etapa,
                etapa_descricao,
                id_coluna_kanban
            FROM DM_ETAPAS_PROCESSO 
            ORDER BY id_coluna_kanban, id_etapa_processo
        `;
        
        const [rows] = await req.db.execute(query);
        
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar etapas:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar as etapas'
        });
    }
});

/**
 * GET /api/etapas/:id
 * Busca uma etapa especÀ­fica por ID
 */
router.get('/etapas/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT 
                id_etapa_processo,
                etapa,
                etapa_descricao,
                id_coluna_kanban
            FROM DM_ETAPAS_PROCESSO 
            WHERE id_etapa_processo = ?
        `;
        
        const [rows] = await req.db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ 
                error: 'Etapa não enãontrada',
                message: `Etapa com ID ${id} não existe`
            });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao buscar etapa:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar a etapa'
        });
    }
});

/**
 * GET /api/etapas/:id/sub-etapas
 * Busca sub-etapas válidas para uma etapa especÀ­fica
 */
router.get('/etapas/:id/sub-etapas', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT 
                s.id_subetapa,
                s.nome_subetapa
            FROM DM_ETAPA_SUBETAPAS_VALIDAS esv
            INNER JOIN DM_SUBETAPA_PROCESSOS s ON esv.id_subetapa = s.id_subetapa
            WHERE esv.id_etapa_processo = ?
            ORDER BY s.nome_subetapa
        `;
        
        const [rows] = await req.db.execute(query, [id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar sub-etapas:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar as sub-etapas'
        });
    }
});

/**
 * GET /api/etapas/por-nome/:nome
 * Busca etapa por nome
 */
router.get('/etapas/por-nome/:nome', authenticateToken, async (req, res) => {
    try {
        const { nome } = req.params;
        
        const query = `
            SELECT 
                id_etapa_processo,
                etapa,
                etapa_descricao,
                id_coluna_kanban
            FROM DM_ETAPAS_PROCESSO 
            WHERE LOWER(etapa) = LOWER(?)
        `;
        
        const [rows] = await req.db.execute(query, [nome]);
        
        if (rows.length === 0) {
            return res.status(404).json({ 
                error: 'Etapa não enãontrada',
                message: `Etapa '${nome}' não existe`
            });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao buscar etapa por nome:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar a etapa'
        });
    }
});

// ===== ROTAS PARA SUB-ETAPAS =====

/**
 * GET /api/sub-etapas
 * Busca todas as sub-etapas disponÀ­veis
 */
router.get('/sub-etapas', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                id_subetapa,
                nome_subetapa
            FROM DM_SUBETAPA_PROCESSOS 
            ORDER BY nome_subetapa
        `;
        
        const [rows] = await req.db.execute(query);
        
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar sub-etapas:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar as sub-etapas'
        });
    }
});

// ===== ROTAS PARA COMBINAÀ‡À•ES =====

/**
 * GET /api/etapas/combinacoes-validas
 * Busca todas as combinaÀ§Àµes válidas de etapa-subetapa
 */
router.get('/etapas/combinacoes-validas', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                esv.id_etapa_processo,
                esv.id_subetapa,
                e.etapa as nome_etapa,
                e.etapa_descricao,
                s.nome_subetapa,
                e.id_coluna_kanban
            FROM DM_ETAPA_SUBETAPAS_VALIDAS esv
            INNER JOIN DM_ETAPAS_PROCESSO e ON esv.id_etapa_processo = e.id_etapa_processo
            INNER JOIN DM_SUBETAPA_PROCESSOS s ON esv.id_subetapa = s.id_subetapa
            ORDER BY e.id_coluna_kanban, e.id_etapa_processo, s.nome_subetapa
        `;
        
        const [rows] = await req.db.execute(query);
        
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar combinaÀ§Àµes válidas:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar as combinaÀ§Àµes válidas'
        });
    }
});

/**
 * GET /api/etapas/por-coluna/:colunaId
 * Busca etapas de uma coluna especÀ­fica do Kanban
 */
router.get('/etapas/por-coluna/:colunaId', authenticateToken, async (req, res) => {
    try {
        const { colunaId } = req.params;
        
        const query = `
            SELECT 
                id_etapa_processo,
                etapa,
                etapa_descricao,
                id_coluna_kanban
            FROM DM_ETAPAS_PROCESSO 
            WHERE id_coluna_kanban = ?
            ORDER BY id_etapa_processo
        `;
        
        const [rows] = await req.db.execute(query, [colunaId]);
        
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar etapas por coluna:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel buscar as etapas da coluna'
        });
    }
});

// ===== ROTAS PARA VALIDAÀ‡ÀƒO =====

/**
 * POST /api/etapas/validar-combinacao
 * Valida se uma combinaÀ§ão etapa-subetapa À© válida
 */
router.post('/etapas/validar-combinacao', authenticateToken, async (req, res) => {
    try {
        const { id_etapa_processo, id_subetapa } = req.body;
        
        if (!id_etapa_processo || !id_subetapa) {
            return res.status(400).json({
                error: 'Parâmetros inválidos',
                message: 'id_etapa_processo e id_subetapa são obrigatÀ³rios'
            });
        }
        
        const query = `
            SELECT COUNT(*) as count
            FROM DM_ETAPA_SUBETAPAS_VALIDAS 
            WHERE id_etapa_processo = ? AND id_subetapa = ?
        `;
        
        const [rows] = await req.db.execute(query, [id_etapa_processo, id_subetapa]);
        
        const isValid = rows[0].count > 0;
        
        res.json({
            valid: isValid,
            message: isValid 
                ? 'CombinaÀ§ão válida' 
                : 'CombinaÀ§ão não permitida para esta etapa'
        });
    } catch (error) {
        console.error('Erro ao validar combinaÀ§ão:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel validar a combinaÀ§ão'
        });
    }
});

// ===== ROTAS ADMINISTRATIVAS =====

/**
 * POST /api/etapas/:etapaId/sub-etapas/:subEtapaId
 * Adiciona uma nova combinaÀ§ão válida (apenas para admins)
 */
router.post('/etapas/:etapaId/sub-etapas/:subEtapaId', authenticateToken, async (req, res) => {
    try {
        // Verificar se o usuário À© admin (implementar conãorme sua lÀ³gica)
        if (!req.user.isAdmin) {
            return res.status(403).json({
                error: 'Acesso negado',
                message: 'Apenas administradores podem adicionar combinaÀ§Àµes'
            });
        }
        
        const { etapaId, subEtapaId } = req.params;
        
        // Verificar se a combinaÀ§ão já existe
        const checkQuery = `
            SELECT COUNT(*) as count
            FROM DM_ETAPA_SUBETAPAS_VALIDAS 
            WHERE id_etapa_processo = ? AND id_subetapa = ?
        `;
        
        const [checkRows] = await req.db.execute(checkQuery, [etapaId, subEtapaId]);
        
        if (checkRows[0].count > 0) {
            return res.status(409).json({
                error: 'CombinaÀ§ão já existe',
                message: 'Esta combinaÀ§ão já está cadastrada'
            });
        }
        
        // Inserir nova combinaÀ§ão
        const insertQuery = `
            INSERT INTO DM_ETAPA_SUBETAPAS_VALIDAS (id_etapa_processo, id_subetapa)
            VALUES (?, ?)
        `;
        
        await req.db.execute(insertQuery, [etapaId, subEtapaId]);
        
        res.status(201).json({
            message: 'CombinaÀ§ão adicionada com sucesso',
            id_etapa_processo: etapaId,
            id_subetapa: subEtapaId
        });
    } catch (error) {
        console.error('Erro ao adicionar combinaÀ§ão:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel adicionar a combinaÀ§ão'
        });
    }
});

/**
 * DELETE /api/etapas/:etapaId/sub-etapas/:subEtapaId
 * Remove uma combinaÀ§ão válida (apenas para admins)
 */
router.delete('/etapas/:etapaId/sub-etapas/:subEtapaId', authenticateToken, async (req, res) => {
    try {
        // Verificar se o usuário À© admin
        if (!req.user.isAdmin) {
            return res.status(403).json({
                error: 'Acesso negado',
                message: 'Apenas administradores podem remover combinaÀ§Àµes'
            });
        }
        
        const { etapaId, subEtapaId } = req.params;
        
        const deleteQuery = `
            DELETE FROM DM_ETAPA_SUBETAPAS_VALIDAS 
            WHERE id_etapa_processo = ? AND id_subetapa = ?
        `;
        
        const [result] = await req.db.execute(deleteQuery, [etapaId, subEtapaId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: 'CombinaÀ§ão não enãontrada',
                message: 'A combinaÀ§ão especificada não existe'
            });
        }
        
        res.json({
            message: 'CombinaÀ§ão removida com sucesso'
        });
    } catch (error) {
        console.error('Erro ao remover combinaÀ§ão:', error);
        res.status(500).json({ 
            error: 'Erro interno do servidor',
            message: 'Não foi possÀ­vel remover a combinaÀ§ão'
        });
    }
});

module.exports = router;

// ===== EXEMPLO DE USO NO APP PRINCIPAL =====

/*
// app.js ou server.js
const express = require('express');
const etapasRoutes = require('./routes/etapas');

const app = express();

// Middleware para parsing JSON
app.use(express.json());

// Middleware de banão de dados (exemplo)
app.use((req, res, next) => {
    req.db = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: 'password',
        database: 'db_ressarcimento'
    });
    next();
});

// Usar as rotas de etapas
app.use('/api', etapasRoutes);

app.listen(8080, () => {
    console.log('Servidor rodanão na porta 8080');
});
*/


