package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Entry es un lote listo para enviar. Body es el JSON EXACTO del cuerpo: al
// reenviar tras un corte se manda el mismo cuerpo y el mismo batch_id, así la
// API lo reconoce como duplicado y no repite el trabajo.
type Entry struct {
	BatchID          string `json:"batch_id"`
	Kind             string `json:"kind"` // KindProducts | KindCustomers
	ReconciliationID string `json:"reconciliation_id,omitempty"`
	Final            bool   `json:"final"`
	Records          int    `json:"records"`
	Body             []byte `json:"body"`
	Commit           Commit `json:"commit"` // huellas a guardar cuando la nube confirme

	// Rellenados al leer de la cola.
	Seq       int64  `json:"-"`
	Attempts  int    `json:"-"`
	LastError string `json:"-"`
}

// MetaLastReconcile es la clave de meta con la fecha de la última reconciliación planificada.
func MetaLastReconcile(kind string) string { return "last_reconcile_" + kind }

// Enqueue guarda los lotes en la cola, en orden y de forma atómica: o entran
// todos o ninguno. Un batch_id repetido se ignora. Cumple sync.Sink.
func (s *Store) Enqueue(ctx context.Context, entries []Entry) error {
	if len(entries) == 0 {
		return nil
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, e := range entries {
			commit, err := json.Marshal(e.Commit)
			if err != nil {
				return err
			}
			final := 0
			if e.Final {
				final = 1
			}
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO outbox
				(batch_id, kind, reconciliation_id, final, records, body, commit_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				e.BatchID, e.Kind, e.ReconciliationID, final, e.Records, e.Body, string(commit),
				time.Now().UTC().Format(time.RFC3339)); err != nil {
				return err
			}
		}
		return nil
	})
}

const outboxCols = "seq, batch_id, kind, reconciliation_id, final, records, body, commit_json, attempts, last_error"

type scanner interface{ Scan(dest ...any) error }

func scanEntry(r scanner) (Entry, error) {
	var e Entry
	var final int
	var commit string
	if err := r.Scan(&e.Seq, &e.BatchID, &e.Kind, &e.ReconciliationID, &final, &e.Records, &e.Body, &commit, &e.Attempts, &e.LastError); err != nil {
		return Entry{}, err
	}
	e.Final = final == 1
	if err := json.Unmarshal([]byte(commit), &e.Commit); err != nil {
		return Entry{}, fmt.Errorf("commit corrupto en el lote %s: %w", e.BatchID, err)
	}
	return e, nil
}

// Next devuelve el lote pendiente más antiguo, o nil si la cola está vacía.
// No lo quita: solo Complete o Discard lo hacen.
func (s *Store) Next(ctx context.Context) (*Entry, error) {
	e, err := scanEntry(s.db.QueryRowContext(ctx, "SELECT "+outboxCols+" FROM outbox ORDER BY seq LIMIT 1"))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: leyendo la cola: %w", err)
	}
	return &e, nil
}

// Depth es la cantidad de lotes pendientes.
func (s *Store) Depth(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM outbox").Scan(&n); err != nil {
		return 0, fmt.Errorf("store: contando la cola: %w", err)
	}
	return n, nil
}

// Complete marca un lote como entregado: guarda sus huellas y lo quita de la
// cola EN LA MISMA TRANSACCIÓN. Si la luz se va a mitad, o ocurren las dos
// cosas o ninguna (y si ninguna, el reenvío es un duplicado inofensivo).
func (s *Store) Complete(ctx context.Context, e Entry) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if e.Commit.Replace {
			if _, err := tx.ExecContext(ctx, "DELETE FROM fingerprints WHERE kind = ?", e.Kind); err != nil {
				return err
			}
		}
		if len(e.Commit.Fingerprints) > 0 {
			if err := put(ctx, tx, e.Kind, e.Commit.Fingerprints); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM outbox WHERE batch_id = ?", e.BatchID)
		return err
	})
}

// Fail anota un intento fallido de envío (el lote sigue en la cola).
func (s *Store) Fail(ctx context.Context, batchID, msg string) error {
	if len(msg) > 500 {
		msg = msg[:500]
	}
	_, err := s.db.ExecContext(ctx, "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE batch_id = ?", msg, batchID)
	if err != nil {
		return fmt.Errorf("store: anotando el fallo: %w", err)
	}
	return nil
}

// Discard descarta un lote que la nube rechazó de forma definitiva (o que
// quedó huérfano). Si pertenece a una reconciliación, descarta también el
// resto de esa reconciliación y borra la marca de "última reconciliación" del
// tipo para que se vuelva a planificar en el próximo ciclo. No guarda huellas.
// Devuelve cuántos lotes se quitaron.
func (s *Store) Discard(ctx context.Context, e Entry) (int, error) {
	n := 0
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var res sql.Result
		var err error
		if e.ReconciliationID != "" {
			res, err = tx.ExecContext(ctx, "DELETE FROM outbox WHERE reconciliation_id = ?", e.ReconciliationID)
			if err == nil {
				_, err = tx.ExecContext(ctx, "DELETE FROM meta WHERE key = ?", MetaLastReconcile(e.Kind))
			}
		} else {
			res, err = tx.ExecContext(ctx, "DELETE FROM outbox WHERE batch_id = ?", e.BatchID)
		}
		if err != nil {
			return err
		}
		c, _ := res.RowsAffected()
		n = int(c)
		return nil
	})
	return n, err
}

// Known devuelve las huellas que cuentan como "ya enviadas": las confirmadas
// más lo que está en la cola pendiente. Así, con la red caída, cada ciclo no
// vuelve a encolar los mismos cambios. Una reconciliación pendiente (su lote
// final lleva Replace) sustituye al conjunto confirmado.
func (s *Store) Known(ctx context.Context, kind string) (map[string]string, error) {
	known, err := s.Fingerprints(ctx, kind)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT commit_json FROM outbox WHERE kind = ? ORDER BY seq", kind)
	if err != nil {
		return nil, fmt.Errorf("store: leyendo la cola: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var c Commit
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, fmt.Errorf("store: commit corrupto en la cola: %w", err)
		}
		if c.Replace {
			known = make(map[string]string, len(c.Fingerprints))
		}
		for k, v := range c.Fingerprints {
			known[k] = v
		}
	}
	return known, rows.Err()
}
