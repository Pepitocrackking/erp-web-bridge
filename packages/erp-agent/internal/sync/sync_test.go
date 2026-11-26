package sync

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/batch"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp/mock"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
)

// memSink simula la entrega: guarda los lotes y, como la nube, los "confirma"
// aplicando sus huellas al almacén.
type memSink struct {
	st      *store.Store
	batches []batch.Entry
}

func (m *memSink) Enqueue(_ context.Context, es []batch.Entry) error {
	m.batches = append(m.batches, es...)
	return nil
}

// deliver confirma todos los lotes pendientes y devuelve los que había.
func (m *memSink) deliver(t *testing.T) []batch.Entry {
	t.Helper()
	got := m.batches
	for _, e := range got {
		if err := m.st.Apply(context.Background(), e.Kind, e.Commit); err != nil {
			t.Fatal(err)
		}
	}
	m.batches = nil
	return got
}

type fixture struct {
	erp    *mock.Adapter
	st     *store.Store
	sink   *memSink
	sy     *Syncer
	now    time.Time
	cfgErr error
}

func setup(t *testing.T, every time.Duration) *fixture {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := &fixture{erp: mock.New(mock.Config{Products: 40, Customers: 5}), st: st, sink: &memSink{st: st}, now: time.Date(2026, 11, 26, 8, 0, 0, 0, time.UTC)}
	f.sy = &Syncer{ERP: f.erp, Store: st, Sink: f.sink, Builder: batch.NewBuilder(), ReconcileEvery: every, Now: func() time.Time { return f.now }}
	return f
}

func recordsOf(t *testing.T, e batch.Entry) []map[string]any {
	t.Helper()
	var b struct {
		Records []map[string]any `json:"records"`
	}
	if err := json.Unmarshal(e.Body, &b); err != nil {
		t.Fatal(err)
	}
	return b.Records
}

func TestPrimerCicloReconciliaYElSiguienteNoEnviaNada(t *testing.T) {
	f := setup(t, 24*time.Hour)
	ctx := context.Background()

	res, err := f.sy.Cycle(ctx, false)
	if err != nil || !res.ReconciledProd || !res.ReconciledCust || res.Batches != 2 {
		t.Fatalf("primer ciclo: %+v %v", res, err)
	}
	f.sink.deliver(t)

	res, err = f.sy.Cycle(ctx, false)
	if err != nil || res.Batches != 0 || res.ProductsChanged != 0 || res.ProductsUnchanged != 40 {
		t.Fatalf("segundo ciclo debería ser vacío: %+v %v", res, err)
	}
}

func TestMutarUnProductoEnviaExactamenteUnRegistro(t *testing.T) {
	f := setup(t, 24*time.Hour)
	ctx := context.Background()
	f.sy.Cycle(ctx, false)
	f.sink.deliver(t)

	if err := f.erp.SetPrice("P00007", 99.99); err != nil {
		t.Fatal(err)
	}
	res, err := f.sy.Cycle(ctx, false)
	if err != nil || res.ReconciledProd {
		t.Fatalf("%+v %v", res, err)
	}
	es := f.sink.deliver(t)
	if len(es) != 1 {
		t.Fatalf("lotes = %d, quiero 1", len(es))
	}
	recs := recordsOf(t, es[0])
	if len(recs) != 1 || recs[0]["sku"] != "P00007" || recs[0]["price_usd"] != 99.99 {
		t.Fatalf("registros = %v", recs)
	}
}

func TestLoNoConfirmadoSeVuelveAEnviar(t *testing.T) {
	f := setup(t, 24*time.Hour)
	ctx := context.Background()
	f.sy.Cycle(ctx, false)
	f.sink.deliver(t)

	f.erp.SetStock("P00002", 1234)
	f.sy.Cycle(ctx, false)
	f.sink.batches = nil // la entrega falló: no se aplicaron las huellas

	f.sy.Cycle(ctx, false)
	es := f.sink.deliver(t)
	if len(es) != 1 || len(recordsOf(t, es[0])) != 1 {
		t.Fatalf("debería reenviar el cambio no confirmado: %d lotes", len(es))
	}
}

func TestReconciliacionPeriodicaQuitaLoEliminado(t *testing.T) {
	f := setup(t, 24*time.Hour)
	ctx := context.Background()
	f.sy.Cycle(ctx, false)
	f.sink.deliver(t)

	f.erp.Remove("P00010")
	// Antes de que venza el intervalo, el delta NO ve las eliminaciones.
	f.now = f.now.Add(23 * time.Hour)
	res, _ := f.sy.Cycle(ctx, false)
	if res.ReconciledProd || res.Batches != 0 {
		t.Fatalf("no tocaba reconciliar aún: %+v", res)
	}
	// Vence el intervalo: reconcilia con 39 productos.
	f.now = f.now.Add(2 * time.Hour)
	res, err := f.sy.Cycle(ctx, false)
	if err != nil || !res.ReconciledProd {
		t.Fatalf("debía reconciliar: %+v %v", res, err)
	}
	es := f.sink.deliver(t)
	var fin batch.Entry
	for _, e := range es {
		if e.Kind == store.KindProducts {
			fin = e
		}
	}
	var body struct {
		Final bool `json:"final_batch"`
		Total int  `json:"total_records"`
	}
	json.Unmarshal(fin.Body, &body)
	if !body.Final || body.Total != 39 || len(recordsOf(t, fin)) != 39 {
		t.Fatalf("lote final = %+v", body)
	}
	known, _ := f.st.Fingerprints(ctx, store.KindProducts)
	if _, ok := known["P00010"]; ok || len(known) != 39 {
		t.Fatalf("el almacén local debe olvidar lo eliminado: %d huellas", len(known))
	}
	// Y no vuelve a reconciliar hasta dentro de otro intervalo.
	if res, _ = f.sy.Cycle(ctx, false); res.ReconciledProd {
		t.Fatal("no debía reconciliar otra vez")
	}
}

func TestForzarReconciliacion(t *testing.T) {
	f := setup(t, 0) // sin reconciliación automática
	ctx := context.Background()
	if res, _ := f.sy.Cycle(ctx, false); res.ReconciledProd || res.ProductsChanged != 40 {
		t.Fatalf("con intervalo 0 es delta puro: %+v", res)
	}
	f.sink.deliver(t)
	if res, _ := f.sy.Cycle(ctx, true); !res.ReconciledProd || !res.ReconciledCust {
		t.Fatalf("force debe reconciliar: %+v", res)
	}
}

func TestERPVacioNoDesactivaElCatalogo(t *testing.T) {
	f := setup(t, 24*time.Hour)
	ctx := context.Background()
	f.sy.Cycle(ctx, false)
	f.sink.deliver(t)

	vacio := mock.New(mock.Config{Products: 1, Customers: 1})
	vacio.Remove("P00001")
	f.sy.ERP = vacio
	res, err := f.sy.Cycle(ctx, true)
	if !errors.Is(err, ErrEmptyInventory) || res.ReconciledProd {
		t.Fatalf("debía negarse a reconciliar un ERP vacío: %+v %v", res, err)
	}
	for _, e := range f.sink.batches {
		if e.Kind == store.KindProducts {
			t.Fatal("no debió encolarse ningún lote de productos")
		}
	}
}

func TestErrorDeProductosNoImpideClientes(t *testing.T) {
	f := setup(t, 24*time.Hour)
	f.sy.ERP = failingProducts{f.erp}
	res, err := f.sy.Cycle(context.Background(), false)
	if err == nil || !res.ReconciledCust {
		t.Fatalf("clientes debían procesarse: %+v %v", res, err)
	}
}

type failingProducts struct{ *mock.Adapter }

func (failingProducts) Products(context.Context) ([]erp.Product, error) {
	return nil, context.DeadlineExceeded
}
