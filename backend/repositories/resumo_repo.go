package repositories

import (
    "context"
    "crypto/sha1"
    "database/sql"
    "encoding/hex"
    "fmt"
)

type ResumoRow struct {
    ProcessoID  int64
    SummaryText sql.NullString
    Status      string
    HistoryHash string
}

type ResumoRepo struct{ db *sql.DB }

func NewResumoRepo(db *sql.DB) *ResumoRepo { return &ResumoRepo{db: db} }

// EnsureTable creates the summary table if not exists (idempotent)
func (r *ResumoRepo) EnsureTable(ctx context.Context) error {
    q := `CREATE TABLE IF NOT EXISTS FT_RESUMOS_PROCESSO (
        processo_id BIGINT PRIMARY KEY,
        summary_text LONGTEXT NULL,
        status ENUM('pending','ready','error') NOT NULL DEFAULT 'pending',
        history_hash VARCHAR(64) NOT NULL DEFAULT '',
        model_provider VARCHAR(32) NULL,
        model_name VARCHAR(64) NULL,
        last_error TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    _, err := r.db.ExecContext(ctx, q)
    return err
}

// ComputeHistoricoHash derives a simple hash of the process history to detect changes
func (r *ResumoRepo) ComputeHistoricoHash(ctx context.Context, processoID int64) (string, error) {
    var maxTs sql.NullTime
    var cnt sql.NullInt64
    err := r.db.QueryRowContext(ctx, `SELECT MAX(data_movimentacao), COUNT(1) FROM FT_HISTORICO_MOVIMENTACOES WHERE id_requisicao = ?`, processoID).Scan(&maxTs, &cnt)
    if err != nil {
        return "", err
    }
    base := fmt.Sprintf("%d|%t|%d", processoID, maxTs.Valid, cnt.Int64)
    if maxTs.Valid {
        base = fmt.Sprintf("%s|%d", base, maxTs.Time.Unix())
    }
    h := sha1.Sum([]byte(base))
    return hex.EncodeToString(h[:]), nil
}

// UpsertPendingIfChanged creates/updates summary row to pending when history changed
func (r *ResumoRepo) UpsertPendingIfChanged(ctx context.Context, processoID int64) (changed bool, err error) {
    hash, err := r.ComputeHistoricoHash(ctx, processoID)
    if err != nil { return false, err }
    var existing string
    _ = r.db.QueryRowContext(ctx, `SELECT history_hash FROM FT_RESUMOS_PROCESSO WHERE processo_id = ?`, processoID).Scan(&existing)
    if existing == hash && existing != "" {
        return false, nil
    }
    // upsert
    _, err = r.db.ExecContext(ctx, `INSERT INTO FT_RESUMOS_PROCESSO (processo_id, status, history_hash, updated_at)
        VALUES (?, 'pending', ?, NOW())
        ON DUPLICATE KEY UPDATE status='pending', history_hash=VALUES(history_hash), updated_at=NOW()`, processoID, hash)
    if err != nil { return false, err }
    return true, nil
}

// Get returns current summary row
func (r *ResumoRepo) Get(ctx context.Context, processoID int64) (*ResumoRow, error) {
    row := &ResumoRow{}
    err := r.db.QueryRowContext(ctx, `SELECT processo_id, summary_text, status, history_hash FROM FT_RESUMOS_PROCESSO WHERE processo_id = ?`, processoID).
        Scan(&row.ProcessoID, &row.SummaryText, &row.Status, &row.HistoryHash)
    if err == sql.ErrNoRows { return nil, nil }
    if err != nil { return nil, err }
    return row, nil
}

// ListPending returns a limited set of pending summaries
func (r *ResumoRepo) ListPending(ctx context.Context, limit int) ([]int64, error) {
    q := `SELECT processo_id FROM FT_RESUMOS_PROCESSO WHERE status = 'pending' ORDER BY updated_at ASC LIMIT ?`
    rows, err := r.db.QueryContext(ctx, q, limit)
    if err != nil { return nil, err }
    defer rows.Close()
    out := make([]int64, 0, limit)
    for rows.Next() {
        var id int64
        if err := rows.Scan(&id); err == nil {
            out = append(out, id)
        }
    }
    return out, nil
}

// SaveReady stores the generated summary
func (r *ResumoRepo) SaveReady(ctx context.Context, processoID int64, text, provider, model string) error {
    _, err := r.db.ExecContext(ctx, `UPDATE FT_RESUMOS_PROCESSO SET summary_text = ?, status='ready', model_provider=?, model_name=?, last_error=NULL, updated_at=NOW() WHERE processo_id = ?`, text, provider, model, processoID)
    return err
}

// SaveError stores error state
func (r *ResumoRepo) SaveError(ctx context.Context, processoID int64, lastErr string) error {
    _, err := r.db.ExecContext(ctx, `UPDATE FT_RESUMOS_PROCESSO SET status='error', last_error=?, updated_at=NOW() WHERE processo_id = ?`, lastErr, processoID)
    return err
}

// CountByStatus returns how many rows are in a given status
func (r *ResumoRepo) CountByStatus(ctx context.Context, status string) (int64, error) {
    var n sql.NullInt64
    err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM FT_RESUMOS_PROCESSO WHERE status = ?`, status).Scan(&n)
    if err != nil { return 0, err }
    return n.Int64, nil
}

// ListRecentByStatus returns recent processo_ids by status within N minutes
func (r *ResumoRepo) ListRecentByStatus(ctx context.Context, status string, minutes int, limit int) ([]int64, error) {
    q := `SELECT processo_id FROM FT_RESUMOS_PROCESSO 
          WHERE status = ? AND updated_at >= (NOW() - INTERVAL ? MINUTE)
          ORDER BY updated_at DESC LIMIT ?`
    rows, err := r.db.QueryContext(ctx, q, status, minutes, limit)
    if err != nil { return nil, err }
    defer rows.Close()
    out := make([]int64, 0, limit)
    for rows.Next() {
        var id int64
        if err := rows.Scan(&id); err == nil { out = append(out, id) }
    }
    return out, nil
}
