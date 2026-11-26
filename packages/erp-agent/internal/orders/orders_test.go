package orders

import (
	"context"
	"errors"
	"testing"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

type fakeSource struct {
	orders []api.Order
	err    error
	limit  int
}

func (f *fakeSource) PendingOrders(_ context.Context, limit int) ([]api.Order, error) {
	f.limit = limit
	return f.orders, f.err
}

type fakeWriter struct {
	calls   []erp.OrderDraft
	byID    map[string]string
	reject  map[string]bool
	failOn  string
	failErr error
}

func (w *fakeWriter) CreateOrderDraft(_ context.Context, o erp.OrderDraft) (erp.DraftResult, error) {
	w.calls = append(w.calls, o)
	if w.reject[o.WebOrderID] {
		return erp.DraftResult{}, &erp.RejectedError{Reason: "cliente inexistente"}
	}
	if o.WebOrderID == w.failOn {
		return erp.DraftResult{}, w.failErr
	}
	if ref, ok := w.byID[o.WebOrderID]; ok {
		return erp.DraftResult{Reference: ref}, nil
	}
	if w.byID == nil {
		w.byID = map[string]string{}
	}
	ref := "PW000" + string(rune('0'+len(w.byID)+1))
	w.byID[o.WebOrderID] = ref
	return erp.DraftResult{Reference: ref, Created: true}, nil
}

func order(id, cust string) api.Order {
	notes := "con nota"
	return api.Order{ID: id, CustomerCode: cust, TotalUSD: 21, ExchangeRateUsed: 40.5, Notes: &notes,
		Items: []api.OrderItem{{SKU: "P00001", Quantity: 3, UnitPriceUSD: 7}}}
}

func TestLosPedidosSeEscribenEnOrdenYConSusDatos(t *testing.T) {
	src := &fakeSource{orders: []api.Order{order("a", "C1"), order("b", "C2"), order("c", "C3")}}
	w := &fakeWriter{}
	res, err := (&Processor{Source: src, Writer: w}).Cycle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Seen: 3, Created: 3}) {
		t.Fatalf("res = %+v", res)
	}
	for i, id := range []string{"a", "b", "c"} {
		if w.calls[i].WebOrderID != id {
			t.Fatalf("orden roto: llamada %d = %s, quiero %s", i, w.calls[i].WebOrderID, id)
		}
	}
	d := w.calls[0]
	if d.CustomerCode != "C1" || d.TotalUSD != 21 || d.ExchangeRate != 40.5 || d.Notes != "con nota" ||
		len(d.Lines) != 1 || d.Lines[0] != (erp.OrderLine{SKU: "P00001", Quantity: 3, UnitPriceUSD: 7}) {
		t.Fatalf("borrador mal armado: %+v", d)
	}
	if src.limit != DefaultLimit {
		t.Fatalf("limit = %d, quiero %d", src.limit, DefaultLimit)
	}
}

func TestReintentarNoDuplicaElBorrador(t *testing.T) {
	src := &fakeSource{orders: []api.Order{order("a", "C1")}}
	w := &fakeWriter{}
	p := &Processor{Source: src, Writer: w}
	if _, err := p.Cycle(context.Background()); err != nil {
		t.Fatal(err)
	}
	res, err := p.Cycle(context.Background()) // la nube sigue diciendo "pendiente"
	if err != nil {
		t.Fatal(err)
	}
	if res.Created != 0 || res.Existing != 1 || len(w.byID) != 1 {
		t.Fatalf("res = %+v, borradores = %d: el reintento no debe crear otro", res, len(w.byID))
	}
}

func TestUnRechazoNoDetieneLosDemas(t *testing.T) {
	src := &fakeSource{orders: []api.Order{order("a", "C1"), order("b", "NO"), order("c", "C3")}}
	w := &fakeWriter{reject: map[string]bool{"b": true}}
	res, err := (&Processor{Source: src, Writer: w}).Cycle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Seen: 3, Created: 2, Rejected: 1}) {
		t.Fatalf("res = %+v", res)
	}
}

func TestUnErrorTransitorioCortaElCicloYConservaElOrden(t *testing.T) {
	src := &fakeSource{orders: []api.Order{order("a", "C1"), order("b", "C2"), order("c", "C3")}}
	w := &fakeWriter{failOn: "b", failErr: errors.New("conexión rechazada")}
	res, err := (&Processor{Source: src, Writer: w}).Cycle(context.Background())
	if err == nil {
		t.Fatal("quiero el error del ERP")
	}
	if res.Created != 1 || len(w.calls) != 2 {
		t.Fatalf("res = %+v, llamadas = %d: 'c' no debe intentarse antes que 'b'", res, len(w.calls))
	}
}

func TestSiLaNubeFallaNoSeEscribeNada(t *testing.T) {
	w := &fakeWriter{}
	_, err := (&Processor{Source: &fakeSource{err: &api.Error{Status: 0, Message: "sin red"}}, Writer: w}).Cycle(context.Background())
	if err == nil || len(w.calls) != 0 {
		t.Fatalf("err = %v, llamadas = %d", err, len(w.calls))
	}
}
