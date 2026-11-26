// Package store es la base SQLite local del agente (SQLite pura Go, sin CGO,
// para conservar el .exe único). Guarda las huellas de lo ya enviado a la nube
// y, más adelante, la cola de lotes pendientes.
//
// Está pensada para sobrevivir a cortes de luz: journal WAL con
// synchronous=FULL, y las escrituras múltiples van en una transacción.
package store

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// Tipos de entidad (columna kind).
const (
	KindProducts  = "products"
	KindCustomers = "customers"
)

// migrations se aplican en orden; el índice+1 es la versión (PRAGMA user_version).
// Nunca se edita una migración ya publicada: se añade otra al final.
var migrations = []string{
	`CREATE TABLE fingerprints (
		kind        TEXT NOT NULL,
		key         TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		PRIMARY KEY (kind, key)
	) WITHOUT ROWID`,
	`CREATE TABLE meta (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	) WITHOUT ROWID`,
}

// Commit describe qué huellas se guardan cuando la nube confirma un lote.
// Replace=true sustituye TODAS las huellas del tipo (último lote de una
// reconciliación completa); si no, se insertan o actualizan las indicadas.
type Commit struct {
	Replace      bool              `json:"replace"`
	Fingerprints map[string]string `json:"fingerprints"`
}

// Apply guarda las huellas de un lote ya confirmado por la nube.
func (s *Store) Apply(ctx context.Context, kind string, c Commit) error {
	if c.Replace {
		return s.Replace(ctx, kind, c.Fingerprints)
	}
	if len(c.Fingerprints) == 0 {
		return nil
	}
	return s.Put(ctx, kind, c.Fingerprints)
}

// Meta devuelve un valor de la tabla meta ("" si no existe).
func (s *Store) Meta(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, "SELECT value FROM meta WHERE key = ?", key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("store: leyendo meta %q: %w", key, err)
	}
	return v, nil
}

// SetMeta guarda un valor en la tabla meta.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	if err != nil {
		return fmt.Errorf("store: guardando meta %q: %w", key, err)
	}
	return nil
}

// Store es la base local. Es seguro para uso concurrente.
type Store struct {
	db *sql.DB
}

// Open abre (o crea) la base en path y aplica las migraciones pendientes.
// Para pruebas, ":memory:" no sirve con varias conexiones: usa un archivo temporal.
func Open(ctx context.Context, path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: abriendo %s: %w", path, err)
	}
	db.SetMaxOpenConns(1) // un solo escritor: simple y sin SQLITE_BUSY
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close cierra la base.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	var v int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil {
		return fmt.Errorf("store: leyendo la versión: %w", err)
	}
	if v > len(migrations) {
		return fmt.Errorf("store: la base es de una versión más nueva (%d) que este agente (%d)", v, len(migrations))
	}
	for i := v; i < len(migrations); i++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: migración %d: %w", i+1, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: migración %d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: migración %d: %w", i+1, err)
		}
	}
	return nil
}

// Fingerprints devuelve todas las huellas conocidas de un tipo (clave -> huella).
func (s *Store) Fingerprints(ctx context.Context, kind string) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT key, fingerprint FROM fingerprints WHERE kind = ?", kind)
	if err != nil {
		return nil, fmt.Errorf("store: leyendo huellas: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, f string
		if err := rows.Scan(&k, &f); err != nil {
			return nil, fmt.Errorf("store: leyendo huellas: %w", err)
		}
		out[k] = f
	}
	return out, rows.Err()
}

// Put guarda (inserta o reemplaza) huellas, todas en una transacción: o entran
// todas o ninguna. Se llama DESPUÉS de que la nube confirmó el lote.
func (s *Store) Put(ctx context.Context, kind string, fps map[string]string) error {
	return s.tx(ctx, func(tx *sql.Tx) error { return put(ctx, tx, kind, fps) })
}

// Replace sustituye TODAS las huellas de un tipo por fps, de forma atómica.
// Es lo que hace la reconciliación completa: lo que ya no está en el ERP deja
// de estar también aquí.
func (s *Store) Replace(ctx context.Context, kind string, fps map[string]string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM fingerprints WHERE kind = ?", kind); err != nil {
			return err
		}
		return put(ctx, tx, kind, fps)
	})
}

// Delete borra las huellas de las claves indicadas.
func (s *Store) Delete(ctx context.Context, kind string, keys []string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, k := range keys {
			if _, err := tx.ExecContext(ctx, "DELETE FROM fingerprints WHERE kind = ? AND key = ?", kind, k); err != nil {
				return err
			}
		}
		return nil
	})
}

func put(ctx context.Context, tx *sql.Tx, kind string, fps map[string]string) error {
	st, err := tx.PrepareContext(ctx, `INSERT INTO fingerprints (kind, key, fingerprint) VALUES (?, ?, ?)
		ON CONFLICT (kind, key) DO UPDATE SET fingerprint = excluded.fingerprint`)
	if err != nil {
		return err
	}
	defer st.Close()
	for k, f := range fps {
		if _, err := st.ExecContext(ctx, kind, k, f); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) tx(ctx context.Context, f func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}
	if err := f(tx); err != nil {
		tx.Rollback()
		return fmt.Errorf("store: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: %w", err)
	}
	return nil
}
