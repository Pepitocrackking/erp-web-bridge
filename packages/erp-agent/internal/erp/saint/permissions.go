package saint

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

var _ erp.WriteIsolationChecker = (*Adapter)(nil)

// VerifyWriteIsolation comprueba, preguntándole a SQL Server, que el login con el que conecta el
// agente NO puede escribir fuera de los borradores: ni en tablas fiscales ni en los datos
// maestros que solo lee, y que no es miembro de un rol con escritura global (sysadmin, db_owner,
// db_datawriter). Es la verificación en vivo de la segunda capa de la garantía de cero riesgo
// contable: no basta con que exista un login restringido, hay que comprobar que es el que se usa.
//
// Devuelve *erp.UnsafeLoginError si el login puede escribir donde no debe; cualquier otro error
// (conexión caída...) es transitorio.
func (a *Adapter) VerifyWriteIsolation(ctx context.Context) error {
	m := a.mapping
	if m.OrderDraft == nil {
		return nil // sin order_draft el agente no escribe nada
	}
	var problems []string

	// Roles con escritura global.
	var sysadmin, dbOwner, dbWriter, user sql.NullString
	rows, err := a.db.QueryContext(ctx, "SELECT CAST(IS_SRVROLEMEMBER('sysadmin') AS INT), CAST(IS_MEMBER('db_owner') AS INT), CAST(IS_MEMBER('db_datawriter') AS INT), SUSER_SNAME()")
	if err != nil {
		return fmt.Errorf("saint: comprobando los permisos del login: %w", err)
	}
	if rows.Next() {
		if err := rows.Scan(&sysadmin, &dbOwner, &dbWriter, &user); err != nil {
			rows.Close()
			return fmt.Errorf("saint: comprobando los permisos del login: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("saint: comprobando los permisos del login: %w", err)
	}
	rows.Close()
	if sysadmin.String == "1" {
		problems = append(problems, "es sysadmin")
	}
	if dbOwner.String == "1" {
		problems = append(problems, "es db_owner de la base")
	}
	if dbWriter.String == "1" {
		problems = append(problems, "pertenece al rol db_datawriter")
	}

	// Permisos concretos sobre cada tabla protegida (las que no existen en esta base se ignoran).
	for _, t := range m.ProtectedSet() {
		r, err := a.db.QueryContext(ctx, `SELECT
			CASE WHEN OBJECT_ID(@p1) IS NULL THEN NULL ELSE HAS_PERMS_BY_NAME(@p1, 'OBJECT', 'INSERT') END,
			CASE WHEN OBJECT_ID(@p1) IS NULL THEN NULL ELSE HAS_PERMS_BY_NAME(@p1, 'OBJECT', 'UPDATE') END,
			CASE WHEN OBJECT_ID(@p1) IS NULL THEN NULL ELSE HAS_PERMS_BY_NAME(@p1, 'OBJECT', 'DELETE') END`, t)
		if err != nil {
			return fmt.Errorf("saint: comprobando los permisos sobre %s: %w", t, err)
		}
		var ins, upd, del sql.NullString
		if r.Next() {
			if err := r.Scan(&ins, &upd, &del); err != nil {
				r.Close()
				return fmt.Errorf("saint: comprobando los permisos sobre %s: %w", t, err)
			}
		}
		if err := r.Err(); err != nil {
			r.Close()
			return fmt.Errorf("saint: comprobando los permisos sobre %s: %w", t, err)
		}
		r.Close()
		var can []string
		for _, p := range []struct {
			name string
			v    sql.NullString
		}{{"INSERT", ins}, {"UPDATE", upd}, {"DELETE", del}} {
			if p.v.String == "1" {
				can = append(can, p.name)
			}
		}
		if len(can) > 0 {
			sort.Strings(can)
			problems = append(problems, fmt.Sprintf("puede %s en %s", strings.Join(can, "/"), t))
		}
	}

	if len(problems) > 0 {
		return &erp.UnsafeLoginError{Login: user.String, Problems: problems}
	}
	return nil
}
