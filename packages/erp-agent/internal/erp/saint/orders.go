package saint

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// TxBeginner lo cumple *sql.DB. Sin él, el adaptador es de solo lectura.
type TxBeginner interface {
	BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error)
}

var _ erp.OrderWriter = (*Adapter)(nil)

// CreateOrderDraft implementa erp.OrderWriter: deja el pedido web como BORRADOR en las dos
// tablas que el mapeo declara en order_draft (cabecera y renglones), en una sola transacción.
//
// Idempotente: el id del pedido web se guarda en una columna con índice único. Si ya existe un
// borrador con ese id, se devuelve su número sin escribir nada. Nunca toca otras tablas.
func (a *Adapter) CreateOrderDraft(ctx context.Context, o erp.OrderDraft) (erp.DraftResult, error) {
	if a.mapping.OrderDraft == nil {
		return erp.DraftResult{}, errors.New("saint: el mapeo no define order_draft: no se pueden escribir pedidos")
	}
	b, ok := a.db.(TxBeginner)
	if !ok {
		return erp.DraftResult{}, errors.New("saint: la conexión no admite transacciones: no se pueden escribir pedidos")
	}
	if strings.TrimSpace(o.WebOrderID) == "" || len(o.Lines) == 0 {
		return erp.DraftResult{}, &erp.RejectedError{Reason: "pedido sin id o sin renglones"}
	}
	m := a.mapping

	// 1) ¿Ya existe? (reintento): se devuelve su número y no se escribe nada.
	if ref, found, err := a.existingDraft(ctx, a.db, o.WebOrderID); err != nil {
		return erp.DraftResult{}, err
	} else if found {
		a.log.Info("el borrador ya existía", "pedido_web", o.WebOrderID, "referencia", ref)
		return erp.DraftResult{Reference: ref, Created: false}, nil
	}

	stx, err := b.BeginTx(ctx, nil)
	if err != nil {
		return erp.DraftResult{}, fmt.Errorf("saint: iniciando la transacción: %w", err)
	}
	// Todo lo que se ejecuta aquí pasa por la lista blanca: SELECT, o INSERT en las tablas del borrador.
	tx := guardedTx{tx: stx, allowed: m.OrderDraft.WriteTables()}
	defer tx.Rollback() //nolint:errcheck // tras Commit es un no-op

	// 2) Validaciones permanentes: el cliente y los SKU deben existir y estar activos en el ERP.
	if err := m.checkCustomer(ctx, tx, o.CustomerCode); err != nil {
		return erp.DraftResult{}, err
	}
	if err := m.checkProducts(ctx, tx, o.Lines); err != nil {
		return erp.DraftResult{}, err
	}

	// 3) Escritura: cabecera (con el correlativo) y renglones.
	ref, err := insertReturning(ctx, tx, m.insertHeaderSQL(o.Notes != ""), m.insertHeaderArgs(o)...)
	if err != nil {
		// Otro proceso pudo crearlo entre el paso 1 y este (índice único): si existe, es un reintento.
		_ = tx.Rollback()
		if ref2, found, err2 := a.existingDraft(ctx, a.db, o.WebOrderID); err2 == nil && found {
			return erp.DraftResult{Reference: ref2, Created: false}, nil
		}
		return erp.DraftResult{}, fmt.Errorf("saint: guardando la cabecera del borrador: %w", err)
	}
	for i, l := range o.Lines {
		if _, err := tx.ExecContext(ctx, m.insertItemSQL(), ref, i+1, l.SKU, float64(l.Quantity), l.UnitPriceUSD,
			round2(float64(l.Quantity)*l.UnitPriceUSD)); err != nil {
			return erp.DraftResult{}, fmt.Errorf("saint: guardando el renglón %d del borrador: %w", i+1, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return erp.DraftResult{}, fmt.Errorf("saint: confirmando el borrador: %w", err)
	}
	a.log.Info("borrador creado", "pedido_web", o.WebOrderID, "referencia", ref, "renglones", len(o.Lines))
	return erp.DraftResult{Reference: ref, Created: true}, nil
}

// insertReturning ejecuta un INSERT ... OUTPUT y devuelve el valor generado (el número del borrador).
func insertReturning(ctx context.Context, tx guardedTx, query string, args ...any) (string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("el INSERT no devolvió el número del borrador")
	}
	var v string
	if err := rows.Scan(&v); err != nil {
		return "", err
	}
	return strings.TrimSpace(v), rows.Close()
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// existingDraft busca el borrador de un pedido web por su id.
func (a *Adapter) existingDraft(ctx context.Context, db DB, webID string) (string, bool, error) {
	h := a.mapping.OrderDraft.Header
	rows, err := db.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %s WHERE %s = @p1",
		q(h.Fields["number"].Column), q(h.Table), q(h.Fields["web_id"].Column)), webID)
	if err != nil {
		return "", false, fmt.Errorf("saint: buscando el borrador: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return "", false, rows.Err()
	}
	var ref string
	if err := rows.Scan(&ref); err != nil {
		return "", false, fmt.Errorf("saint: buscando el borrador: %w", err)
	}
	return strings.TrimSpace(ref), true, nil
}

// queryer es lo que usan las validaciones (lo cumple *sql.Tx).
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func (m *Mapping) checkCustomer(ctx context.Context, db queryer, code string) error {
	e, f := m.Customer, m.Customer.Fields
	query := fmt.Sprintf("SELECT CASE WHEN p.%s = %d THEN 1 ELSE 0 END FROM %s p WHERE p.%s = @p1%s",
		q(f["active"].Column), *f["active"].TrueWhen, q(e.Table), q(f["customer_code"].Column), andFilter(e.Filter))
	rows, err := db.QueryContext(ctx, query, code)
	if err != nil {
		return fmt.Errorf("saint: comprobando el cliente: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return fmt.Errorf("saint: comprobando el cliente: %w", err)
		}
		return &erp.RejectedError{Reason: fmt.Sprintf("el cliente %q no existe en el ERP", code)}
	}
	var active int
	if err := rows.Scan(&active); err != nil {
		return fmt.Errorf("saint: comprobando el cliente: %w", err)
	}
	if active != 1 {
		return &erp.RejectedError{Reason: fmt.Sprintf("el cliente %q está inactivo en el ERP", code)}
	}
	return nil
}

// checkProducts verifica que todos los SKU existan y estén activos; lista los que no.
func (m *Mapping) checkProducts(ctx context.Context, db queryer, lines []erp.OrderLine) error {
	e, f := m.Product, m.Product.Fields
	args := make([]any, 0, len(lines))
	marks := make([]string, 0, len(lines))
	for i, l := range lines {
		args = append(args, l.SKU)
		marks = append(marks, fmt.Sprintf("@p%d", i+1))
	}
	query := fmt.Sprintf("SELECT p.%s, CASE WHEN p.%s = %d THEN 1 ELSE 0 END FROM %s p WHERE p.%s IN (%s)%s",
		q(f["sku"].Column), q(f["active"].Column), *f["active"].TrueWhen, q(e.Table),
		q(f["sku"].Column), strings.Join(marks, ","), andFilter(e.Filter))
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("saint: comprobando los productos: %w", err)
	}
	defer rows.Close()
	active := map[string]bool{}
	for rows.Next() {
		var sku string
		var ok int
		if err := rows.Scan(&sku, &ok); err != nil {
			return fmt.Errorf("saint: comprobando los productos: %w", err)
		}
		active[strings.ToUpper(strings.TrimSpace(sku))] = ok == 1 // SQL Server compara sin distinguir mayúsculas
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("saint: comprobando los productos: %w", err)
	}
	var missing, inactive []string
	for _, l := range lines {
		ok, found := active[strings.ToUpper(strings.TrimSpace(l.SKU))]
		switch {
		case !found:
			missing = append(missing, l.SKU)
		case !ok:
			inactive = append(inactive, l.SKU)
		}
	}
	if len(missing) == 0 && len(inactive) == 0 {
		return nil
	}
	sort.Strings(missing)
	sort.Strings(inactive)
	var parts []string
	if len(missing) > 0 {
		parts = append(parts, "no existen en el ERP: "+strings.Join(missing, ", "))
	}
	if len(inactive) > 0 {
		parts = append(parts, "están inactivos en el ERP: "+strings.Join(inactive, ", "))
	}
	return &erp.RejectedError{Reason: "productos que " + strings.Join(parts, "; ")}
}

func andFilter(filter *string) string {
	if filter == nil || strings.TrimSpace(*filter) == "" {
		return ""
	}
	return " AND (" + *filter + ")"
}

// insertHeaderSQL arma el INSERT de la cabecera. El número sale del correlativo del ERP y se
// devuelve con OUTPUT. Orden de los parámetros: ver insertHeaderArgs.
func (m *Mapping) insertHeaderSQL(withNotes bool) string {
	d := m.OrderDraft
	h, s := d.Header, d.Header.NumberSequence
	f := h.Fields
	cols := []string{q(f["number"].Column), q(f["web_id"].Column), q(f["customer_code"].Column),
		q(f["total_usd"].Column), q(f["exchange_rate"].Column), q(f["status"].Column)}
	number := fmt.Sprintf("'%s' + RIGHT(REPLICATE('0', %d) + CAST(NEXT VALUE FOR %s AS VARCHAR(20)), %d)",
		s.Prefix, s.Width, q(s.Name), s.Width)
	vals := []string{number, "@p1", "@p2", "@p3", "@p4", "@p5"}
	if withNotes {
		if n, ok := f["notes"]; ok && n.Column != "" {
			cols = append(cols, q(n.Column))
			vals = append(vals, "@p6")
		}
	}
	return fmt.Sprintf("INSERT INTO %s (%s) OUTPUT INSERTED.%s VALUES (%s)",
		q(h.Table), strings.Join(cols, ", "), q(f["number"].Column), strings.Join(vals, ", "))
}

func (m *Mapping) insertHeaderArgs(o erp.OrderDraft) []any {
	f := m.OrderDraft.Header.Fields
	args := []any{o.WebOrderID, o.CustomerCode, round2(o.TotalUSD), o.ExchangeRate, *f["status"].Value}
	if o.Notes != "" {
		if n, ok := f["notes"]; ok && n.Column != "" {
			args = append(args, truncate(o.Notes, 500))
		}
	}
	return args
}

// insertItemSQL arma el INSERT de un renglón. Parámetros: número, línea, SKU, cantidad, precio, total.
func (m *Mapping) insertItemSQL() string {
	i := m.OrderDraft.Items
	f := i.Fields
	return fmt.Sprintf("INSERT INTO %s (%s, %s, %s, %s, %s, %s) VALUES (@p1, @p2, @p3, @p4, @p5, @p6)",
		q(i.Table), q(f["number"].Column), q(f["line"].Column), q(f["sku"].Column),
		q(f["quantity"].Column), q(f["unit_price_usd"].Column), q(f["line_total_usd"].Column))
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
