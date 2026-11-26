package erp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestProductJSONUsaNombresSnakeCaseDelContrato(t *testing.T) {
	cat := "Bebidas"
	b, err := json.Marshal(Product{SKU: "P00001", Name: "Agua", Category: &cat, PriceUSD: 1.5, Stock: 10, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"sku":"P00001","name":"Agua","category":"Bebidas","price_usd":1.5,"stock":10,"active":true}`
	if string(b) != want {
		t.Fatalf("JSON = %s, quiero %s", b, want)
	}
}

func TestProductSinCategoriaOmiteElCampo(t *testing.T) {
	b, _ := json.Marshal(Product{SKU: "P1", Name: "X"})
	if strings.Contains(string(b), "category") {
		t.Fatalf("category debería omitirse: %s", b)
	}
}

func TestProductRecordAplanaElProductoYAgregaElHash(t *testing.T) {
	b, err := json.Marshal(ProductRecord{Product: Product{SKU: "P1", Name: "X", PriceUSD: 2}, SyncHash: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"sku":"P1","name":"X","price_usd":2,"stock":0,"active":false,"sync_hash":"abc"}`
	if string(b) != want {
		t.Fatalf("JSON = %s, quiero %s", b, want)
	}
}

func TestCustomerJSONUsaNombresSnakeCaseDelContrato(t *testing.T) {
	b, err := json.Marshal(Customer{CustomerCode: "C00001", TaxID: "J-1", BusinessName: "ACME", CreditLimitUSD: 1000, CurrentDebtUSD: 250.5, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"customer_code":"C00001","tax_id":"J-1","business_name":"ACME","credit_limit_usd":1000,"current_debt_usd":250.5,"active":true}`
	if string(b) != want {
		t.Fatalf("JSON = %s, quiero %s", b, want)
	}
}

// fakeAdapter comprueba en compilación que la interfaz es implementable.
type fakeAdapter struct{}

func (fakeAdapter) Type() string                                  { return TypeMock }
func (fakeAdapter) Products(context.Context) ([]Product, error)   { return nil, nil }
func (fakeAdapter) Customers(context.Context) ([]Customer, error) { return nil, nil }

var _ Adapter = fakeAdapter{}

func TestTiposDeERPCoincidenConLaBase(t *testing.T) {
	if TypeSaint != "saint" || TypeMock != "mock" {
		t.Fatalf("tipos inesperados: %q %q", TypeSaint, TypeMock)
	}
}
