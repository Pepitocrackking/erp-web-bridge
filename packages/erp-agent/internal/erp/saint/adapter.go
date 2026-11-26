package saint

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// DB es lo mínimo que el adaptador necesita de la conexión (lo cumple *sql.DB).
type DB interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Adapter lee productos y clientes de una base de Saint Enterprise. Es de
// solo lectura: solo ejecuta SELECT.
type Adapter struct {
	db      DB
	mapping *Mapping
	log     *slog.Logger
}

var _ erp.Adapter = (*Adapter)(nil)

// New crea el adaptador. log puede ser nil.
func New(db DB, m *Mapping, log *slog.Logger) *Adapter {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Adapter{db: db, mapping: m, log: log}
}

// Type implementa erp.Adapter.
func (a *Adapter) Type() string { return erp.TypeSaint }

func q(id string) string { return "[" + id + "]" }

// productQuery construye el SELECT de productos. Columnas, en orden:
// sku, name, category, price, stock, active (1/0).
func (m *Mapping) productQuery() string {
	e, f := m.Product, m.Product.Fields
	col := func(name string) string { return "p." + q(f[name].Column) }

	category, join := "NULL", ""
	if c, ok := f["category"]; ok && c.Column != "" {
		if c.Lookup != nil {
			category = "c." + q(c.Lookup.Label)
			join = fmt.Sprintf(" LEFT JOIN %s c ON c.%s = p.%s", q(c.Lookup.Table), q(c.Lookup.Key), q(c.Column))
		} else {
			category = "p." + q(c.Column)
		}
	}
	return fmt.Sprintf("SELECT %s, %s, %s, %s, %s, CASE WHEN %s = %d THEN 1 ELSE 0 END FROM %s p%s%s ORDER BY %s",
		col("sku"), col("name"), category, col("price_usd"), col("stock"),
		col("active"), *f["active"].TrueWhen,
		q(e.Table), join, where(e.Filter), col("sku"))
}

// customerQuery construye el SELECT de clientes. Columnas, en orden:
// code, business_name, tax_id, credit_limit, debt, active (1/0).
func (m *Mapping) customerQuery() string {
	e, f := m.Customer, m.Customer.Fields
	col := func(name string) string { return "p." + q(f[name].Column) }
	return fmt.Sprintf("SELECT %s, %s, %s, %s, %s, CASE WHEN %s = %d THEN 1 ELSE 0 END FROM %s p%s ORDER BY %s",
		col("customer_code"), col("business_name"), col("tax_id"),
		col("credit_limit_usd"), col("current_debt_usd"),
		col("active"), *f["active"].TrueWhen,
		q(e.Table), where(e.Filter), col("customer_code"))
}

func where(filter *string) string {
	if filter == nil || strings.TrimSpace(*filter) == "" {
		return ""
	}
	return " WHERE (" + *filter + ")"
}

// Products implementa erp.Adapter.
func (a *Adapter) Products(ctx context.Context) ([]erp.Product, error) {
	rows, err := a.db.QueryContext(ctx, a.mapping.productQuery())
	if err != nil {
		return nil, fmt.Errorf("saint: leyendo productos: %w", err)
	}
	defer rows.Close()

	var out []erp.Product
	seen := map[string]bool{}
	for rows.Next() {
		var sku, name, cat, price, stock, active sql.NullString
		if err := rows.Scan(&sku, &name, &cat, &price, &stock, &active); err != nil {
			return nil, fmt.Errorf("saint: leyendo productos: %w", err)
		}
		p, reason := toProduct(sku, name, cat, price, stock, active)
		if reason != "" {
			a.log.Warn("producto omitido", "sku", strings.TrimSpace(sku.String), "motivo", reason)
			continue
		}
		if seen[p.SKU] {
			return nil, fmt.Errorf("saint: SKU repetido en el ERP: %q (revisa el filtro del mapeo)", p.SKU)
		}
		seen[p.SKU] = true
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("saint: leyendo productos: %w", err)
	}
	return out, nil
}

// Customers implementa erp.Adapter.
func (a *Adapter) Customers(ctx context.Context) ([]erp.Customer, error) {
	rows, err := a.db.QueryContext(ctx, a.mapping.customerQuery())
	if err != nil {
		return nil, fmt.Errorf("saint: leyendo clientes: %w", err)
	}
	defer rows.Close()

	var out []erp.Customer
	seen := map[string]bool{}
	for rows.Next() {
		var code, name, tax, limit, debt, active sql.NullString
		if err := rows.Scan(&code, &name, &tax, &limit, &debt, &active); err != nil {
			return nil, fmt.Errorf("saint: leyendo clientes: %w", err)
		}
		c, reason := toCustomer(code, name, tax, limit, debt, active)
		if reason != "" {
			a.log.Warn("cliente omitido", "customer_code", strings.TrimSpace(code.String), "motivo", reason)
			continue
		}
		if seen[c.CustomerCode] {
			return nil, fmt.Errorf("saint: cliente repetido en el ERP: %q (revisa el filtro del mapeo)", c.CustomerCode)
		}
		seen[c.CustomerCode] = true
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("saint: leyendo clientes: %w", err)
	}
	return out, nil
}

// num convierte un NUMERIC/DECIMAL de SQL Server (llega como texto) a float64.
// NULL cuenta como 0.
func num(s sql.NullString) (float64, error) {
	if !s.Valid || strings.TrimSpace(s.String) == "" {
		return 0, nil
	}
	return strconv.ParseFloat(strings.TrimSpace(s.String), 64)
}

// toProduct normaliza una fila. Devuelve un motivo no vacío si la fila no es
// válida para el contrato (la API exige sku y nombre no vacíos y precio >= 0).
// Reglas: el stock negativo (posible en Saint) se envía como 0.
func toProduct(sku, name, cat, price, stock, active sql.NullString) (erp.Product, string) {
	s := strings.TrimSpace(sku.String)
	if s == "" {
		return erp.Product{}, "SKU vacío"
	}
	n := strings.TrimSpace(name.String)
	if n == "" {
		return erp.Product{}, "nombre vacío"
	}
	pr, err := num(price)
	if err != nil || pr < 0 {
		return erp.Product{}, fmt.Sprintf("precio inválido %q", price.String)
	}
	st, err := num(stock)
	if err != nil {
		return erp.Product{}, fmt.Sprintf("existencia inválida %q", stock.String)
	}
	if st < 0 {
		st = 0
	}
	p := erp.Product{SKU: s, Name: n, PriceUSD: pr, Stock: st, Active: strings.TrimSpace(active.String) == "1"}
	if c := strings.TrimSpace(cat.String); cat.Valid && c != "" {
		p.Category = &c
	}
	return p, ""
}

func toCustomer(code, name, tax, limit, debt, active sql.NullString) (erp.Customer, string) {
	c := strings.TrimSpace(code.String)
	if c == "" {
		return erp.Customer{}, "código vacío"
	}
	n := strings.TrimSpace(name.String)
	if n == "" {
		return erp.Customer{}, "razón social vacía"
	}
	t := strings.TrimSpace(tax.String)
	if t == "" {
		return erp.Customer{}, "RIF vacío"
	}
	lim, err := num(limit)
	if err != nil || lim < 0 {
		return erp.Customer{}, fmt.Sprintf("límite de crédito inválido %q", limit.String)
	}
	d, err := num(debt)
	if err != nil {
		return erp.Customer{}, fmt.Sprintf("saldo inválido %q", debt.String)
	}
	return erp.Customer{CustomerCode: c, TaxID: t, BusinessName: n, CreditLimitUSD: lim, CurrentDebtUSD: d, Active: strings.TrimSpace(active.String) == "1"}, ""
}
