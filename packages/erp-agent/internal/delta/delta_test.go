package delta

import (
	"testing"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

func ptr(s string) *string { return &s }

// Vectores fijos calculados con sha256sum sobre los bytes de la forma canónica.
func TestSyncHashVectoresFijos(t *testing.T) {
	casos := []struct {
		nombre string
		p      erp.Product
		want   string
	}{
		{"saint 4 decimales se redondea a 2", erp.Product{SKU: "P00001", Name: "AGUA MINERAL FRESCOLITA 2 L", PriceUSD: 2.0912, Stock: 264}, "5e44f57a3d875a4b92a412a608ea83c6cb4910bb0e2d8a1dd5e58d30026669cb"},
		{"unicode y precio entero", erp.Product{SKU: "A", Name: "Ñandú café", PriceUSD: 1.5, Stock: 10}, "00ca2c77eeae47f3c7a3bd1c2c9b545f6176eaddb1f1288e199f88444553b6b4"},
		{"ceros", erp.Product{SKU: "X", Name: "N"}, "6fc783da715a3abb344b9eb6f7e3890ac464129acd141860067d694172f436a2"},
		{"espacios sobrantes se ignoran", erp.Product{SKU: " P00001 ", Name: "  AGUA MINERAL FRESCOLITA 2 L ", PriceUSD: 2.09, Stock: 264.004}, "5e44f57a3d875a4b92a412a608ea83c6cb4910bb0e2d8a1dd5e58d30026669cb"},
	}
	for _, c := range casos {
		if got := SyncHash(c.p); got != c.want {
			t.Errorf("%s: hash = %s, quiero %s", c.nombre, got, c.want)
		}
	}
}

func TestSyncHashNoDependeDeCategoriaNiActivo(t *testing.T) {
	a := erp.Product{SKU: "P1", Name: "X", PriceUSD: 1, Stock: 1, Active: true, Category: ptr("A")}
	b := a
	b.Active, b.Category = false, ptr("B")
	if SyncHash(a) != SyncHash(b) {
		t.Fatal("el hash del contrato solo cubre sku+precio+stock+nombre")
	}
}

func TestSyncHashCambiaConCadaCampoDelContrato(t *testing.T) {
	base := erp.Product{SKU: "P1", Name: "X", PriceUSD: 1, Stock: 1}
	h := SyncHash(base)
	for nombre, m := range map[string]erp.Product{
		"sku":    {SKU: "P2", Name: "X", PriceUSD: 1, Stock: 1},
		"nombre": {SKU: "P1", Name: "Y", PriceUSD: 1, Stock: 1},
		"precio": {SKU: "P1", Name: "X", PriceUSD: 1.01, Stock: 1},
		"stock":  {SKU: "P1", Name: "X", PriceUSD: 1, Stock: 1.01},
	} {
		if SyncHash(m) == h {
			t.Errorf("cambiar %s no cambió el hash", nombre)
		}
	}
}

func TestSyncHashSeparadorEvitaColisiones(t *testing.T) {
	a := erp.Product{SKU: "AB", Name: "C"}
	b := erp.Product{SKU: "A", Name: "BC"}
	if SyncHash(a) == SyncHash(b) {
		t.Fatal("campos desplazados no deben colisionar")
	}
}

func TestRedondeoNoCambiaElHashSiLoGuardadoNoCambia(t *testing.T) {
	// 1.4849 y 1.4851 son 1.48 y 1.49: distintos. 1.4801 y 1.4849 son ambos 1.48: iguales.
	a := erp.Product{SKU: "P", Name: "N", PriceUSD: 1.4801}
	b := erp.Product{SKU: "P", Name: "N", PriceUSD: 1.4849}
	c := erp.Product{SKU: "P", Name: "N", PriceUSD: 1.4851}
	if SyncHash(a) != SyncHash(b) {
		t.Fatal("1.4801 y 1.4849 se guardan igual (1.48): mismo hash")
	}
	if SyncHash(b) == SyncHash(c) {
		t.Fatal("1.48 y 1.49 son distintos")
	}
}

func TestRound2(t *testing.T) {
	for in, want := range map[float64]float64{1.234: 1.23, 1.236: 1.24, 0.125: 0.13, -0.001: 0, 0: 0, 10: 10} {
		if got := Round2(in); got != want {
			t.Errorf("Round2(%v) = %v, quiero %v", in, got, want)
		}
	}
}

func lista() []erp.Product {
	return []erp.Product{
		{SKU: "P1", Name: "A", PriceUSD: 1, Stock: 5, Active: true, Category: ptr("C1")},
		{SKU: "P2", Name: "B", PriceUSD: 2, Stock: 6, Active: true},
		{SKU: "P3", Name: "C", PriceUSD: 3, Stock: 7, Active: true},
	}
}

func known(ps []erp.Product) map[string]string {
	m := map[string]string{}
	for _, p := range ps {
		m[p.SKU] = ProductFingerprint(p)
	}
	return m
}

func TestDiffPrimeraVezEnviaTodo(t *testing.T) {
	d := DiffProducts(lista(), map[string]string{})
	if len(d.Changed) != 3 || d.Unchanged != 0 || len(d.Fingerprints) != 3 {
		t.Fatalf("diff = %+v", d)
	}
	if d.Changed[0].SyncHash != SyncHash(lista()[0]) {
		t.Fatal("el registro debe llevar el sync_hash del contrato")
	}
}

func TestDiffSinCambiosNoEnviaNada(t *testing.T) {
	d := DiffProducts(lista(), known(lista()))
	if len(d.Changed) != 0 || d.Unchanged != 3 {
		t.Fatalf("diff = %+v", d)
	}
}

func TestDiffUnSoloProductoCambiado(t *testing.T) {
	k := known(lista())
	ps := lista()
	ps[1].PriceUSD = 2.50
	d := DiffProducts(ps, k)
	if len(d.Changed) != 1 || d.Changed[0].SKU != "P2" || d.Unchanged != 2 {
		t.Fatalf("diff = %+v", d)
	}
}

func TestDiffDetectaCategoriaYActivoAunqueElHashNoCambie(t *testing.T) {
	k := known(lista())
	ps := lista()
	ps[0].Category = ptr("C2")
	ps[2].Active = false
	d := DiffProducts(ps, k)
	if len(d.Changed) != 2 {
		t.Fatalf("esperaba 2 cambios (categoría y activo), got %d", len(d.Changed))
	}
	if d.Changed[0].SyncHash != SyncHash(lista()[0]) {
		t.Fatal("el sync_hash no debe cambiar por categoría")
	}
}

func TestDiffIgnoraCambiosMenoresAlCentavo(t *testing.T) {
	k := known(lista())
	ps := lista()
	ps[0].PriceUSD = 1.0004 // se guarda como 1.00
	if d := DiffProducts(ps, k); len(d.Changed) != 0 {
		t.Fatalf("un cambio por debajo del centavo no debe enviarse: %+v", d.Changed)
	}
}

func TestDiffProductoNuevoSeEnvia(t *testing.T) {
	k := known(lista())
	ps := append(lista(), erp.Product{SKU: "P4", Name: "D", PriceUSD: 4, Stock: 1, Active: true})
	d := DiffProducts(ps, k)
	if len(d.Changed) != 1 || d.Changed[0].SKU != "P4" {
		t.Fatalf("diff = %+v", d)
	}
}

func TestDiffClientes(t *testing.T) {
	cs := []erp.Customer{
		{CustomerCode: "C1", TaxID: "J-1", BusinessName: "A", CreditLimitUSD: 100, CurrentDebtUSD: 10, Active: true},
		{CustomerCode: "C2", TaxID: "J-2", BusinessName: "B", CreditLimitUSD: 200, CurrentDebtUSD: 20, Active: true},
	}
	k := map[string]string{}
	for _, c := range cs {
		k[c.CustomerCode] = CustomerFingerprint(c)
	}
	if d := DiffCustomers(cs, k); len(d.Changed) != 0 || d.Unchanged != 2 {
		t.Fatalf("sin cambios: %+v", d)
	}
	cs[1].CurrentDebtUSD = 25.5
	d := DiffCustomers(cs, k)
	if len(d.Changed) != 1 || d.Changed[0].CustomerCode != "C2" || d.Changed[0].CurrentDebtUSD != 25.5 {
		t.Fatalf("diff = %+v", d)
	}
}
