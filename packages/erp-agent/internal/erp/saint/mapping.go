// Package saint implementa erp.Adapter para Saint Enterprise (SQL Server).
//
// Los nombres de tablas y columnas NO están en el código: se leen del archivo
// de mapeo YAML (infra/saint-sandbox/mapping.saint.yaml), porque varían entre
// versiones de Saint. El código solo conoce los campos canónicos.
package saint

import (
	"fmt"
	"os"
	"regexp"

	"gopkg.in/yaml.v3"
)

// identRe restringe los identificadores SQL del mapeo: sin esto, un YAML
// malformado podría inyectar SQL en las consultas que se construyen.
var identRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Lookup describe una tabla de la que se obtiene la etiqueta de un código
// (p. ej. SAINSTA para la categoría del producto).
type Lookup struct {
	Table string `yaml:"table"`
	Key   string `yaml:"key"`
	Label string `yaml:"label"`
}

// Field mapea un campo canónico a una columna de Saint.
type Field struct {
	Column   string  `yaml:"column"`
	Lookup   *Lookup `yaml:"lookup"`
	TrueWhen *int    `yaml:"true_when"` // para booleanos: valor de la columna que significa "activo"
	Value    *string `yaml:"value"`     // valor fijo que el agente escribe en la columna (p. ej. el estado "borrador")
}

// Entity describe cómo leer una entidad (productos o clientes).
type Entity struct {
	Table  string           `yaml:"table"`
	Fields map[string]Field `yaml:"fields"`
	// Filter es una condición SQL opcional que se añade al WHERE. Viene del
	// archivo de configuración del operador (confiable), no de datos externos.
	Filter *string `yaml:"filter"`
}

// Mapping es el contenido (relevante para el agente) del archivo de mapeo.
type Mapping struct {
	Version  int    `yaml:"version"`
	ERP      string `yaml:"erp"`
	Product  Entity `yaml:"product"`
	Customer Entity `yaml:"customer"`
	// OrderDraft dice dónde se escriben los pedidos web (solo borradores). Es opcional: sin él,
	// el agente solo lee y los pedidos quedan pendientes.
	OrderDraft *OrderDraft `yaml:"order_draft"`
}

var (
	productFields  = []string{"sku", "name", "price_usd", "stock", "active"} // category es opcional
	customerFields = []string{"customer_code", "business_name", "tax_id", "credit_limit_usd", "current_debt_usd", "active"}
)

// LoadMapping lee y valida un archivo de mapeo.
func LoadMapping(path string) (*Mapping, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("saint: leyendo el mapeo: %w", err)
	}
	return ParseMapping(b)
}

// ParseMapping interpreta y valida el YAML del mapeo.
func ParseMapping(data []byte) (*Mapping, error) {
	var m Mapping
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("saint: mapeo inválido: %w", err)
	}
	if m.ERP != "saint" {
		return nil, fmt.Errorf("saint: el mapeo es para erp=%q, se esperaba \"saint\"", m.ERP)
	}
	if err := m.Product.validate("product", productFields, []string{"category"}); err != nil {
		return nil, err
	}
	if err := m.Customer.validate("customer", customerFields, nil); err != nil {
		return nil, err
	}
	if m.OrderDraft != nil {
		if err := m.OrderDraft.validate(); err != nil {
			return nil, err
		}
	}
	return &m, nil
}

func (e Entity) validate(name string, required, optional []string) error {
	if !identRe.MatchString(e.Table) {
		return fmt.Errorf("saint: %s.table inválida: %q", name, e.Table)
	}
	known := map[string]bool{}
	for _, f := range required {
		known[f] = true
		if _, ok := e.Fields[f]; !ok {
			return fmt.Errorf("saint: falta el campo %s.fields.%s", name, f)
		}
	}
	for _, f := range optional {
		known[f] = true
	}
	for fname, f := range e.Fields {
		if !known[fname] {
			continue // campos extra del mapeo (cost_usd...) que el agente no usa
		}
		if !identRe.MatchString(f.Column) {
			return fmt.Errorf("saint: %s.fields.%s.column inválida: %q", name, fname, f.Column)
		}
		if l := f.Lookup; l != nil {
			for _, id := range []string{l.Table, l.Key, l.Label} {
				if !identRe.MatchString(id) {
					return fmt.Errorf("saint: %s.fields.%s.lookup inválido: %q", name, fname, id)
				}
			}
		}
	}
	if f := e.Fields["active"]; f.TrueWhen == nil {
		return fmt.Errorf("saint: %s.fields.active necesita true_when", name)
	}
	return nil
}
