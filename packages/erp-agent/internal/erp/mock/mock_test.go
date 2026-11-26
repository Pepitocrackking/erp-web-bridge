package mock

import (
	"context"
	"reflect"
	"testing"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

func mustProducts(t *testing.T, a *Adapter) []erp.Product {
	t.Helper()
	ps, err := a.Products(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return ps
}

func TestMismaConfigGeneraLosMismosDatos(t *testing.T) {
	a, b := New(Config{Products: 80, Customers: 12, Seed: 7}), New(Config{Products: 80, Customers: 12, Seed: 7})
	if !reflect.DeepEqual(mustProducts(t, a), mustProducts(t, b)) {
		t.Fatal("los productos difieren entre dos adaptadores con la misma Config")
	}
	ca, _ := a.Customers(context.Background())
	cb, _ := b.Customers(context.Background())
	if !reflect.DeepEqual(ca, cb) {
		t.Fatal("los clientes difieren entre dos adaptadores con la misma Config")
	}
}

func TestSemillaDistintaGeneraDatosDistintos(t *testing.T) {
	a, b := New(Config{Seed: 1}), New(Config{Seed: 2})
	if reflect.DeepEqual(mustProducts(t, a), mustProducts(t, b)) {
		t.Fatal("semillas distintas produjeron los mismos datos")
	}
}

func TestValoresPorDefectoYFormaDeLosDatos(t *testing.T) {
	a := New(Config{})
	ps := mustProducts(t, a)
	if len(ps) != 50 {
		t.Fatalf("productos = %d, quiero 50", len(ps))
	}
	if ps[0].SKU != "P00001" || ps[49].SKU != "P00050" {
		t.Fatalf("SKU fuera de orden: %s ... %s", ps[0].SKU, ps[49].SKU)
	}
	seen := map[string]bool{}
	for _, p := range ps {
		if seen[p.SKU] {
			t.Fatalf("SKU repetido %s", p.SKU)
		}
		seen[p.SKU] = true
		if p.Name == "" || p.PriceUSD <= 0 || p.Stock < 0 {
			t.Fatalf("producto inválido: %+v", p)
		}
	}
	cs, _ := a.Customers(context.Background())
	if len(cs) != 10 || cs[0].CustomerCode != "C00001" {
		t.Fatalf("clientes inesperados: %d, primero %s", len(cs), cs[0].CustomerCode)
	}
	if a.Type() != erp.TypeMock {
		t.Fatalf("Type() = %q", a.Type())
	}
}

func TestMutateEsDeterministaYCambiaSoloLoEsperado(t *testing.T) {
	a, b := New(Config{Products: 50}), New(Config{Products: 50})
	before := mustProducts(t, a)
	touchedA := a.Mutate()
	touchedB := b.Mutate()
	if !reflect.DeepEqual(touchedA, touchedB) || !reflect.DeepEqual(mustProducts(t, a), mustProducts(t, b)) {
		t.Fatal("Mutate no es determinista")
	}
	if want := []string{"P00001", "P00002", "P00003", "P00004", "P00005"}; !reflect.DeepEqual(touchedA, want) {
		t.Fatalf("tocados = %v, quiero %v", touchedA, want)
	}
	after := mustProducts(t, a)
	changed := 0
	for i := range after {
		if after[i] != before[i] {
			changed++
		}
	}
	// Los 3 de precio siempre cambian; los 2 de stock cambian salvo que ya estén en 0.
	if changed < 3 || changed > 5 {
		t.Fatalf("cambiaron %d productos, esperaba entre 3 y 5", changed)
	}
	// El segundo paso empieza donde terminó el primero.
	if got := a.Mutate(); got[0] != "P00004" {
		t.Fatalf("segundo paso empieza en %s, quiero P00004", got[0])
	}
}

func TestMutacionesExplicitas(t *testing.T) {
	a := New(Config{Products: 10})
	if err := a.SetPrice("P00001", 12.345); err != nil {
		t.Fatal(err)
	}
	if err := a.SetStock("P00002", 7); err != nil {
		t.Fatal(err)
	}
	if err := a.SetActive("P00003", false); err != nil {
		t.Fatal(err)
	}
	if err := a.Remove("P00004"); err != nil {
		t.Fatal(err)
	}
	a.Add(erp.Product{SKU: "P99999", Name: "NUEVO", PriceUSD: 1, Stock: 1, Active: true})

	by := map[string]erp.Product{}
	for _, p := range mustProducts(t, a) {
		by[p.SKU] = p
	}
	if by["P00001"].PriceUSD != 12.35 { // redondeado a 2 decimales
		t.Fatalf("precio = %v", by["P00001"].PriceUSD)
	}
	if by["P00002"].Stock != 7 || by["P00003"].Active {
		t.Fatalf("stock/active no cambiaron: %+v %+v", by["P00002"], by["P00003"])
	}
	if _, ok := by["P00004"]; ok {
		t.Fatal("P00004 debería haberse eliminado")
	}
	if _, ok := by["P99999"]; !ok || len(by) != 10 {
		t.Fatalf("Add falló o conteo = %d", len(by))
	}
	for _, f := range []func() error{
		func() error { return a.SetPrice("NOPE", 1) },
		func() error { return a.SetStock("NOPE", 1) },
		func() error { return a.SetActive("NOPE", true) },
		func() error { return a.Remove("NOPE") },
	} {
		if f() == nil {
			t.Fatal("esperaba error con un SKU inexistente")
		}
	}
}

func TestRespetaContextoCancelado(t *testing.T) {
	a := New(Config{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.Products(ctx); err == nil {
		t.Fatal("Products debería fallar con ctx cancelado")
	}
	if _, err := a.Customers(ctx); err == nil {
		t.Fatal("Customers debería fallar con ctx cancelado")
	}
}

func TestProductsDevuelveCopiaIndependiente(t *testing.T) {
	a := New(Config{Products: 5})
	ps := mustProducts(t, a)
	ps[0].PriceUSD = 9999
	if mustProducts(t, a)[0].PriceUSD == 9999 {
		t.Fatal("modificar el resultado alteró el estado interno")
	}
}
