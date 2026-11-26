package batch

import (
	"encoding/json"
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/delta"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

func testBuilder() *Builder {
	n := 0
	return &Builder{
		MaxRecords: MaxRecords,
		Now:        func() time.Time { return time.Date(2026, 11, 26, 15, 4, 5, 123_000_000, time.UTC) },
		NewID:      func() string { n++; return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) },
	}
}

func products(n int) []erp.Product {
	ps := make([]erp.Product, n)
	for i := range ps {
		ps[i] = erp.Product{SKU: fmt.Sprintf("P%05d", i+1), Name: "X", PriceUSD: 1.23456, Stock: 3, Active: true}
	}
	return ps
}

func decode(t *testing.T, e Entry) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(e.Body, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestLoteNormalNoLlevaCamposDeReconciliacion(t *testing.T) {
	b := testBuilder()
	d := delta.DiffProducts(products(3), map[string]string{})
	es, err := b.ProductDelta(d)
	if err != nil || len(es) != 1 {
		t.Fatalf("lotes = %d, err = %v", len(es), err)
	}
	m := decode(t, es[0])
	for _, k := range []string{"reconciliation_id", "final_batch", "total_records"} {
		if _, ok := m[k]; ok {
			t.Errorf("un lote normal no debe llevar %s", k)
		}
	}
	if m["full_reconciliation"] != false || m["kind"] != "products" || m["sent_at"] != "2026-11-26T15:04:05.123Z" {
		t.Fatalf("cuerpo = %v", m)
	}
	recs := m["records"].([]any)
	first := recs[0].(map[string]any)
	if len(recs) != 3 || first["price_usd"] != 1.23 || first["sync_hash"] == "" || first["sync_hash"] != delta.SyncHash(products(1)[0]) {
		t.Fatalf("registros = %v", recs)
	}
	if len(es[0].Commit.Fingerprints) != 3 || es[0].Commit.Replace {
		t.Fatalf("commit = %+v", es[0].Commit)
	}
}

func TestSinCambiosNoGeneraLotes(t *testing.T) {
	es, err := testBuilder().ProductDelta(delta.ProductDiff{})
	if err != nil || len(es) != 0 {
		t.Fatalf("%v %v", es, err)
	}
}

func TestReconciliacionSeReparteEnLotesDeMil(t *testing.T) {
	es, err := testBuilder().ReconcileProducts(products(2500))
	if err != nil {
		t.Fatal(err)
	}
	if len(es) != 3 {
		t.Fatalf("lotes = %d, quiero 3", len(es))
	}
	recID := es[0].ReconciliationID
	total := 0
	for i, e := range es {
		m := decode(t, e)
		if m["full_reconciliation"] != true || m["reconciliation_id"] != recID {
			t.Fatalf("lote %d: %v", i, m)
		}
		n := len(m["records"].([]any))
		if n > 1000 {
			t.Fatalf("lote %d con %d registros", i, n)
		}
		total += n
		last := i == len(es)-1
		if m["final_batch"] != last {
			t.Fatalf("lote %d final_batch = %v", i, m["final_batch"])
		}
		_, hasTotal := m["total_records"]
		if hasTotal != last {
			t.Fatalf("lote %d: total_records presente = %v", i, hasTotal)
		}
		if last && m["total_records"] != float64(2500) {
			t.Fatalf("total_records = %v", m["total_records"])
		}
		if last != e.Commit.Replace {
			t.Fatalf("lote %d: solo el último hace Replace", i)
		}
	}
	if total != 2500 || len(es[2].Commit.Fingerprints) != 2500 {
		t.Fatalf("total = %d, huellas = %d", total, len(es[2].Commit.Fingerprints))
	}
	if len(es[0].Commit.Fingerprints) != 0 {
		t.Fatal("los lotes intermedios no guardan huellas")
	}
}

func TestIDsDeLoteSonUnicosYValidos(t *testing.T) {
	es, _ := testBuilder().ReconcileProducts(products(2001))
	seen := map[string]bool{}
	for _, e := range es {
		if seen[e.BatchID] {
			t.Fatal("batch_id repetido")
		}
		seen[e.BatchID] = true
	}
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	for i := 0; i < 50; i++ {
		if id := NewUUID(); !re.MatchString(id) {
			t.Fatalf("UUID inválido: %s", id)
		}
	}
}

func TestInventarioVacioGeneraUnLoteFinalConRegistrosVacios(t *testing.T) {
	es, err := testBuilder().ReconcileProducts(nil)
	if err != nil || len(es) != 1 {
		t.Fatalf("%v %v", es, err)
	}
	m := decode(t, es[0])
	recs, ok := m["records"].([]any)
	if !ok || len(recs) != 0 || m["final_batch"] != true || m["total_records"] != float64(0) {
		t.Fatalf("cuerpo = %v", m)
	}
}

func TestSKURepetidoEsError(t *testing.T) {
	ps := products(2)
	ps[1].SKU = ps[0].SKU
	if _, err := testBuilder().ReconcileProducts(ps); err == nil {
		t.Fatal("esperaba error por SKU repetido")
	}
}

func TestReconciliacionDeClientes(t *testing.T) {
	cs := []erp.Customer{{CustomerCode: "C1", TaxID: "J-1", BusinessName: "A", CreditLimitUSD: 10, CurrentDebtUSD: 1, Active: true}}
	es, err := testBuilder().ReconcileCustomers(cs)
	if err != nil || len(es) != 1 {
		t.Fatalf("%v %v", es, err)
	}
	m := decode(t, es[0])
	if m["kind"] != "customers" || m["final_batch"] != true || m["total_records"] != float64(1) {
		t.Fatalf("cuerpo = %v", m)
	}
}

func TestLimiteDeRegistrosConfigurable(t *testing.T) {
	b := testBuilder()
	b.MaxRecords = 10
	es, _ := b.ReconcileProducts(products(25))
	if len(es) != 3 {
		t.Fatalf("lotes = %d, quiero 3", len(es))
	}
	b.MaxRecords = 99999 // nunca por encima del máximo de la API
	if es, _ = b.ReconcileProducts(products(1001)); len(es) != 2 {
		t.Fatalf("lotes = %d, quiero 2", len(es))
	}
}
