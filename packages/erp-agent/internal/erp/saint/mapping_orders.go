package saint

import (
	"fmt"
	"strings"
)

// OrderDraft describe las dos tablas donde el agente deja un pedido web como borrador.
// Nada más: la lista de tablas donde el agente puede escribir sale de aquí.
type OrderDraft struct {
	Header OrderHeader `yaml:"header"`
	Items  OrderItems  `yaml:"items"`
}

// Sequence genera el correlativo del borrador: Prefix + el número con ceros a la izquierda.
type Sequence struct {
	Name   string `yaml:"name"`
	Prefix string `yaml:"prefix"`
	Width  int    `yaml:"width"`
}

// OrderHeader es la cabecera del borrador.
type OrderHeader struct {
	Table          string           `yaml:"table"`
	NumberSequence Sequence         `yaml:"number_sequence"`
	Fields         map[string]Field `yaml:"fields"`
}

// OrderItems son los renglones del borrador.
type OrderItems struct {
	Table  string           `yaml:"table"`
	Fields map[string]Field `yaml:"fields"`
}

var (
	headerFields = []string{"number", "web_id", "customer_code", "total_usd", "exchange_rate", "status"} // notes es opcional
	itemFields   = []string{"number", "line", "sku", "quantity", "unit_price_usd", "line_total_usd"}
)

// WriteTables son las únicas tablas donde el agente escribe.
func (d *OrderDraft) WriteTables() []string {
	return []string{d.Header.Table, d.Items.Table}
}

func (d *OrderDraft) validate() error {
	h, it := d.Header, d.Items
	if !identRe.MatchString(h.Table) {
		return fmt.Errorf("saint: order_draft.header.table inválida: %q", h.Table)
	}
	if !identRe.MatchString(it.Table) {
		return fmt.Errorf("saint: order_draft.items.table inválida: %q", it.Table)
	}
	if strings.EqualFold(h.Table, it.Table) {
		return fmt.Errorf("saint: order_draft.header y order_draft.items no pueden ser la misma tabla (%q)", h.Table)
	}
	s := h.NumberSequence
	if !identRe.MatchString(s.Name) {
		return fmt.Errorf("saint: order_draft.header.number_sequence.name inválido: %q", s.Name)
	}
	if !identRe.MatchString(s.Prefix) && s.Prefix != "" {
		return fmt.Errorf("saint: order_draft.header.number_sequence.prefix inválido: %q (letras, números y _)", s.Prefix)
	}
	if s.Width < 1 || s.Width > 15 {
		return fmt.Errorf("saint: order_draft.header.number_sequence.width debe estar entre 1 y 15 (es %d)", s.Width)
	}
	if err := checkColumns("order_draft.header", h.Fields, headerFields, []string{"notes"}); err != nil {
		return err
	}
	if v := h.Fields["status"].Value; v == nil || strings.TrimSpace(*v) == "" {
		return fmt.Errorf("saint: order_draft.header.fields.status necesita value (el valor que marca el registro como borrador)")
	}
	return checkColumns("order_draft.items", it.Fields, itemFields, nil)
}

// checkColumns exige los campos obligatorios y valida que cada columna sea un identificador seguro.
func checkColumns(name string, fields map[string]Field, required, optional []string) error {
	known := map[string]bool{}
	for _, f := range required {
		known[f] = true
		if _, ok := fields[f]; !ok {
			return fmt.Errorf("saint: falta el campo %s.fields.%s", name, f)
		}
	}
	for _, f := range optional {
		known[f] = true
	}
	for fname, f := range fields {
		if known[fname] && !identRe.MatchString(f.Column) {
			return fmt.Errorf("saint: %s.fields.%s.column inválida: %q", name, fname, f.Column)
		}
	}
	return nil
}
