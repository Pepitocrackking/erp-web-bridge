package saint

import (
	"database/sql"
	"strings"
	"testing"
)

const mappingPath = "../../../../../infra/saint-sandbox/mapping.saint.yaml"

func loadReal(t *testing.T) *Mapping {
	t.Helper()
	m, err := LoadMapping(mappingPath)
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	return m
}

func TestMapeoRealDelSandboxSeCarga(t *testing.T) {
	m := loadReal(t)
	if m.Product.Table != "SAPROD" || m.Product.Fields["price_usd"].Column != "Precio1" {
		t.Fatalf("producto mal leído: %+v", m.Product)
	}
	if m.Customer.Table != "SACLIE" || m.Customer.Fields["tax_id"].Column != "ID3" {
		t.Fatalf("cliente mal leído: %+v", m.Customer)
	}
	if tw := m.Product.Fields["active"].TrueWhen; tw == nil || *tw != 1 {
		t.Fatalf("true_when mal leído: %v", tw)
	}
}

func TestConsultaDeProductosSaleDelMapeo(t *testing.T) {
	got := loadReal(t).productQuery()
	want := "SELECT p.[CodProd], p.[Descrip], c.[Descrip], p.[Precio1], p.[Existen], CASE WHEN p.[Activo] = 1 THEN 1 ELSE 0 END " +
		"FROM [SAPROD] p LEFT JOIN [SAINSTA] c ON c.[CodInst] = p.[CodInst] ORDER BY p.[CodProd]"
	if got != want {
		t.Fatalf("SQL =\n%s\nquiero\n%s", got, want)
	}
}

func TestConsultaDeClientesSaleDelMapeo(t *testing.T) {
	got := loadReal(t).customerQuery()
	want := "SELECT p.[CodClie], p.[Descrip], p.[ID3], p.[LimiteCred], p.[Saldo], CASE WHEN p.[Activo] = 1 THEN 1 ELSE 0 END " +
		"FROM [SACLIE] p ORDER BY p.[CodClie]"
	if got != want {
		t.Fatalf("SQL =\n%s\nquiero\n%s", got, want)
	}
}

func TestFiltroDelMapeoVaAlWhere(t *testing.T) {
	m := loadReal(t)
	f := "Activo = 1 AND CodProd LIKE 'P%'"
	m.Product.Filter = &f
	if got := m.productQuery(); !strings.Contains(got, " WHERE (Activo = 1 AND CodProd LIKE 'P%') ORDER BY") {
		t.Fatalf("el filtro no llegó al WHERE: %s", got)
	}
}

func TestCambiarElMapeoCambiaLaConsultaSinTocarCodigo(t *testing.T) {
	m := loadReal(t)
	f := m.Product.Fields["price_usd"]
	f.Column = "Precio2"
	m.Product.Fields["price_usd"] = f
	if !strings.Contains(m.productQuery(), "p.[Precio2]") {
		t.Fatal("la columna del mapeo no se refleja en el SQL")
	}
}

func TestMapeoRechazaIdentificadoresPeligrosos(t *testing.T) {
	base := `
erp: saint
product:
  table: "SAPROD; DROP TABLE X"
  fields: {}
customer:
  table: SACLIE
  fields: {}
`
	if _, err := ParseMapping([]byte(base)); err == nil {
		t.Fatal("debería rechazar una tabla con SQL inyectado")
	}
}

func TestMapeoRechazaOtroERPYCamposFaltantes(t *testing.T) {
	if _, err := ParseMapping([]byte("erp: odoo\n")); err == nil {
		t.Fatal("debería rechazar erp distinto de saint")
	}
	sinSKU := `
erp: saint
product:
  table: SAPROD
  fields:
    name: { column: Descrip }
customer:
  table: SACLIE
  fields: {}
`
	_, err := ParseMapping([]byte(sinSKU))
	if err == nil || !strings.Contains(err.Error(), "sku") {
		t.Fatalf("debería quejarse del campo sku, got %v", err)
	}
}

func ns(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }

func TestToProductNormaliza(t *testing.T) {
	p, reason := toProduct(ns(" P00001 "), ns(" ARROZ "), ns("VIVERES"), ns("1.4850"), ns("-3.000"), ns("1"))
	if reason != "" {
		t.Fatal(reason)
	}
	if p.SKU != "P00001" || p.Name != "ARROZ" || p.PriceUSD != 1.485 || p.Stock != 0 || !p.Active || p.Category == nil || *p.Category != "VIVERES" {
		t.Fatalf("producto = %+v", p)
	}
	p, _ = toProduct(ns("P2"), ns("X"), sql.NullString{}, ns("2"), ns("5"), ns("0"))
	if p.Category != nil || p.Active || p.Stock != 5 {
		t.Fatalf("categoría NULL / inactivo mal tratados: %+v", p)
	}
}

func TestToProductOmiteFilasInvalidas(t *testing.T) {
	casos := map[string][6]sql.NullString{
		"sku vacío":       {ns("  "), ns("X"), ns(""), ns("1"), ns("1"), ns("1")},
		"nombre vacío":    {ns("P1"), ns(""), ns(""), ns("1"), ns("1"), ns("1")},
		"precio negativo": {ns("P1"), ns("X"), ns(""), ns("-1"), ns("1"), ns("1")},
		"precio texto":    {ns("P1"), ns("X"), ns(""), ns("abc"), ns("1"), ns("1")},
	}
	for nombre, c := range casos {
		if _, reason := toProduct(c[0], c[1], c[2], c[3], c[4], c[5]); reason == "" {
			t.Errorf("%s: debería omitirse", nombre)
		}
	}
}

func TestToCustomer(t *testing.T) {
	c, reason := toCustomer(ns("C1"), ns("ACME C.A."), ns("J-123"), ns("1000.00"), ns("-50.25"), ns("1"))
	if reason != "" || c.CurrentDebtUSD != -50.25 || c.CreditLimitUSD != 1000 || !c.Active {
		t.Fatalf("cliente = %+v (%s)", c, reason)
	}
	if _, reason := toCustomer(ns("C1"), ns("ACME"), ns(""), ns("1"), ns("1"), ns("1")); reason == "" {
		t.Fatal("RIF vacío debería omitirse")
	}
}
