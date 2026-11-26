package saint

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

// Primera capa de la garantía de "cero riesgo contable": toda sentencia que el agente ejecuta
// dentro de la transacción de un pedido pasa por checkStatement. Solo se admiten
//
//   - SELECT (validar cliente y productos, buscar el borrador), sin SELECT ... INTO, y
//   - INSERT INTO [tabla] donde la tabla es una de las dos del borrador (order_draft del mapeo).
//
// UPDATE, DELETE, MERGE, TRUNCATE, EXEC, DDL, varias sentencias o comentarios se rechazan ANTES de
// llegar al servidor. La segunda capa (el login SQL del agente) y la tercera (las pruebas) cubren
// lo que esta pudiera dejar pasar.

var (
	// La tabla debe ir sola entre corchetes (sin esquema ni alias): [dbo].[X] no se interpreta.
	insertRe = regexp.MustCompile(`(?is)^INSERT\s+INTO\s+\[([A-Za-z_][A-Za-z0-9_]*)\](?:\s|\()`)
	intoRe   = regexp.MustCompile(`(?i)\bINTO\b`)
)

// checkStatement devuelve un error si la sentencia no es una lectura ni una inserción en una de las
// tablas permitidas.
func checkStatement(allowed []string, stmt string) error {
	s := strings.TrimSpace(stmt)
	if s == "" {
		return fmt.Errorf("saint: sentencia vacía")
	}
	if strings.ContainsAny(s, ";") || strings.Contains(s, "--") || strings.Contains(s, "/*") {
		return fmt.Errorf("saint: sentencia rechazada: una sola sentencia y sin comentarios")
	}
	head := strings.ToUpper(s)
	switch {
	case strings.HasPrefix(head, "SELECT"):
		if intoRe.MatchString(s) {
			return fmt.Errorf("saint: sentencia rechazada: SELECT ... INTO crea tablas")
		}
		return nil
	case strings.HasPrefix(head, "INSERT"):
		m := insertRe.FindStringSubmatch(s)
		if m == nil {
			return fmt.Errorf("saint: INSERT rechazado: debe ser INSERT INTO [tabla] ...")
		}
		for _, t := range allowed {
			if strings.EqualFold(t, m[1]) {
				return nil
			}
		}
		return fmt.Errorf("saint: INSERT rechazado: %q no es una tabla de borrador (solo %s)", m[1], strings.Join(allowed, ", "))
	}
	word := head
	if i := strings.IndexAny(word, " \t\r\n("); i > 0 {
		word = word[:i]
	}
	return fmt.Errorf("saint: sentencia %s rechazada: el agente solo lee (SELECT) y escribe borradores (INSERT)", word)
}

// guardedTx es la transacción de un pedido con la primera capa puesta: verifica cada sentencia
// antes de enviarla.
type guardedTx struct {
	tx      *sql.Tx
	allowed []string
}

func (g guardedTx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if err := checkStatement(g.allowed, query); err != nil {
		return nil, err
	}
	return g.tx.QueryContext(ctx, query, args...)
}

func (g guardedTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if err := checkStatement(g.allowed, query); err != nil {
		return nil, err
	}
	return g.tx.ExecContext(ctx, query, args...)
}

func (g guardedTx) Commit() error   { return g.tx.Commit() }
func (g guardedTx) Rollback() error { return g.tx.Rollback() }
