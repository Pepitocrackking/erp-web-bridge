package orders

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// cloud simula la API: guarda el estado de cada pedido como lo haría la real.
type cloud struct {
	orders     []api.Order       // pedidos pendientes, en orden
	status     map[string]string // id -> pending_sync | synced_to_erp | error
	reference  map[string]string
	detail     map[string]string
	pendingErr error
	confirmErr map[string]error // por pedido: error al confirmar
	failErr    map[string]error // por pedido: error al informar el fallo
	limit      int
	calls      []string // "confirm:id" y "fail:id", en orden
}

func newCloud(orders ...api.Order) *cloud {
	c := &cloud{orders: orders, status: map[string]string{}, reference: map[string]string{}, detail: map[string]string{},
		confirmErr: map[string]error{}, failErr: map[string]error{}}
	for _, o := range orders {
		c.status[o.ID] = "pending_sync"
	}
	return c
}

func (c *cloud) PendingOrders(_ context.Context, limit int) ([]api.Order, error) {
	c.limit = limit
	if c.pendingErr != nil {
		return nil, c.pendingErr
	}
	var out []api.Order
	for _, o := range c.orders {
		if c.status[o.ID] == "pending_sync" {
			out = append(out, o)
		}
	}
	return out, nil
}

func (c *cloud) ConfirmOrder(_ context.Context, id, ref string) (*api.ConfirmResult, error) {
	c.calls = append(c.calls, "confirm:"+id)
	if err := c.confirmErr[id]; err != nil {
		return nil, err
	}
	dup := c.status[id] == "synced_to_erp"
	c.status[id], c.reference[id] = "synced_to_erp", ref
	return &api.ConfirmResult{ID: id, Status: "synced_to_erp", Reference: ref, Duplicate: dup}, nil
}

func (c *cloud) FailOrder(_ context.Context, id, detail string) error {
	c.calls = append(c.calls, "fail:"+id)
	if err := c.failErr[id]; err != nil {
		return err
	}
	c.status[id], c.detail[id] = "error", detail
	return nil
}

// ledger simula el ERP: borradores por id web, idempotente.
type ledger struct {
	byID    map[string]string
	reject  map[string]string // id -> motivo del rechazo permanente
	failOn  string            // id que falla con un error transitorio
	failErr error
	calls   []string
}

func (w *ledger) CreateOrderDraft(_ context.Context, o erp.OrderDraft) (erp.DraftResult, error) {
	w.calls = append(w.calls, o.WebOrderID)
	if reason, ok := w.reject[o.WebOrderID]; ok {
		return erp.DraftResult{}, &erp.RejectedError{Reason: reason}
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
	ref := fmt.Sprintf("PW%07d", len(w.byID)+1)
	w.byID[o.WebOrderID] = ref
	return erp.DraftResult{Reference: ref, Created: true}, nil
}

func order(id, cust string) api.Order {
	notes := "con nota"
	return api.Order{ID: id, CustomerCode: cust, Status: "pending_sync", TotalUSD: 21, ExchangeRateUsed: 40.5, Notes: &notes,
		Items: []api.OrderItem{{SKU: "P00001", Quantity: 3, UnitPriceUSD: 7}}}
}

func run(t *testing.T, c *cloud, w *ledger) (Result, error) {
	t.Helper()
	return (&Processor{Source: c, Writer: w}).Cycle(context.Background())
}

func TestLosPedidosSeEscribenEnOrdenYSeConfirmanConSuReferencia(t *testing.T) {
	c := newCloud(order("a", "C1"), order("b", "C2"), order("c", "C3"))
	w := &ledger{}
	res, err := run(t, c, w)
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Seen: 3, Created: 3, Confirmed: 3}) {
		t.Fatalf("res = %+v", res)
	}
	for i, id := range []string{"a", "b", "c"} {
		if w.calls[i] != id || c.calls[i] != "confirm:"+id {
			t.Fatalf("orden roto: ERP %v, nube %v", w.calls, c.calls)
		}
		if c.status[id] != "synced_to_erp" || c.reference[id] != w.byID[id] {
			t.Fatalf("%s: estado %q, referencia nube %q, referencia ERP %q", id, c.status[id], c.reference[id], w.byID[id])
		}
	}
	if c.limit != DefaultLimit {
		t.Fatalf("limit = %d, quiero %d", c.limit, DefaultLimit)
	}
}

func TestElBorradorLlevaLosDatosDelPedido(t *testing.T) {
	c := newCloud(order("a", "C1"))
	var got erp.OrderDraft
	w := &captureWriter{ledger: &ledger{}, got: &got}
	if _, err := (&Processor{Source: c, Writer: w}).Cycle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got.WebOrderID != "a" || got.CustomerCode != "C1" || got.TotalUSD != 21 || got.ExchangeRate != 40.5 || got.Notes != "con nota" ||
		len(got.Lines) != 1 || got.Lines[0] != (erp.OrderLine{SKU: "P00001", Quantity: 3, UnitPriceUSD: 7}) {
		t.Fatalf("borrador mal armado: %+v", got)
	}
}

type captureWriter struct {
	*ledger
	got *erp.OrderDraft
}

func (w *captureWriter) CreateOrderDraft(ctx context.Context, o erp.OrderDraft) (erp.DraftResult, error) {
	*w.got = o
	return w.ledger.CreateOrderDraft(ctx, o)
}

func TestSiLaConfirmacionSePierdeElReintentoNoDuplicaElBorrador(t *testing.T) {
	// Se cae la red justo al confirmar: el borrador YA existe en el ERP, pero la nube sigue en pending_sync.
	c := newCloud(order("a", "C1"))
	w := &ledger{}
	c.confirmErr["a"] = &api.Error{Status: 0, Message: "sin conexión"}
	res, err := run(t, c, w)
	if err == nil || res.Created != 1 || res.Confirmed != 0 || c.status["a"] != "pending_sync" {
		t.Fatalf("res = %+v err = %v estado = %s: debe quedar pendiente y avisar el error", res, err, c.status["a"])
	}

	// Vuelve la red: el siguiente ciclo ve el pedido de nuevo, el ERP devuelve el MISMO borrador y se confirma.
	delete(c.confirmErr, "a")
	res, err = run(t, c, w)
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Seen: 1, Existing: 1, Confirmed: 1}) || len(w.byID) != 1 || c.status["a"] != "synced_to_erp" {
		t.Fatalf("res = %+v, borradores = %d, estado = %s: no debe crear otro borrador", res, len(w.byID), c.status["a"])
	}
	if c.reference["a"] != "PW0000001" {
		t.Fatalf("referencia = %q, quiero la del primer intento", c.reference["a"])
	}
	// Un tercer ciclo no tiene nada pendiente.
	if res, err = run(t, c, w); err != nil || res.Seen != 0 {
		t.Fatalf("res = %+v err = %v", res, err)
	}
}

func TestUnRechazoPermanenteSeInformaConSuMotivoYNoDetieneLosDemas(t *testing.T) {
	c := newCloud(order("a", "C1"), order("b", "NO"), order("c", "C3"))
	w := &ledger{reject: map[string]string{"b": `el cliente "NO" no existe en el ERP`}}
	res, err := run(t, c, w)
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Seen: 3, Created: 2, Confirmed: 2, Rejected: 1}) {
		t.Fatalf("res = %+v", res)
	}
	if c.status["b"] != "error" || c.detail["b"] != `el cliente "NO" no existe en el ERP` {
		t.Fatalf("b: estado %q motivo %q", c.status["b"], c.detail["b"])
	}
	if c.status["a"] != "synced_to_erp" || c.status["c"] != "synced_to_erp" {
		t.Fatalf("los demás deben confirmarse: %v", c.status)
	}
	// El pedido en error ya no está pendiente: el siguiente ciclo no lo toca.
	w.calls = nil
	if res, err = run(t, c, w); err != nil || res.Seen != 0 || len(w.calls) != 0 {
		t.Fatalf("res = %+v err = %v llamadas = %v", res, err, w.calls)
	}
}

func TestSiNoSePuedeInformarElRechazoSeRepiteEnElSiguienteCiclo(t *testing.T) {
	c := newCloud(order("a", "NO"))
	w := &ledger{reject: map[string]string{"a": "cliente inexistente"}}
	c.failErr["a"] = &api.Error{Status: 503, Message: "caída"}
	if _, err := run(t, c, w); err == nil || c.status["a"] != "pending_sync" {
		t.Fatalf("err = %v estado = %s: debe cortar el ciclo y seguir pendiente", err, c.status["a"])
	}
	delete(c.failErr, "a")
	if _, err := run(t, c, w); err != nil || c.status["a"] != "error" || c.detail["a"] != "cliente inexistente" {
		t.Fatalf("err = %v estado = %s motivo = %q", err, c.status["a"], c.detail["a"])
	}
}

func TestElPersonalReintentaUnPedidoEnErrorYVuelveAEscribirse(t *testing.T) {
	// El cliente faltaba en el ERP; el personal lo da de alta y reintenta desde el panel.
	c := newCloud(order("a", "C9"))
	w := &ledger{reject: map[string]string{"a": "no existe"}}
	if _, err := run(t, c, w); err != nil || c.status["a"] != "error" {
		t.Fatalf("err = %v estado = %s", err, c.status["a"])
	}
	delete(w.reject, "a")          // ya existe en el ERP
	c.status["a"] = "pending_sync" // lo que hace POST .../retry
	res, err := run(t, c, w)
	if err != nil || res != (Result{Seen: 1, Created: 1, Confirmed: 1}) || c.status["a"] != "synced_to_erp" {
		t.Fatalf("res = %+v err = %v estado = %s", res, err, c.status["a"])
	}
}

func TestUnErrorTransitorioDelERPCortaElCicloYConservaElOrden(t *testing.T) {
	c := newCloud(order("a", "C1"), order("b", "C2"), order("c", "C3"))
	w := &ledger{failOn: "b", failErr: errors.New("conexión rechazada")}
	res, err := run(t, c, w)
	if err == nil {
		t.Fatal("quiero el error del ERP")
	}
	if res.Created != 1 || len(w.calls) != 2 || c.status["b"] != "pending_sync" || c.status["c"] != "pending_sync" {
		t.Fatalf("res = %+v, llamadas = %v: 'c' no debe intentarse antes que 'b'", res, w.calls)
	}
	if len(c.calls) != 1 || c.calls[0] != "confirm:a" {
		t.Fatalf("la nube solo debe saber de 'a': %v", c.calls)
	}
}

func TestConfirmarUnPedidoQueYaNoEstaPendienteSeAnotaYSigue(t *testing.T) {
	// 409: lo anularon en la web mientras el agente escribía el borrador.
	c := newCloud(order("a", "C1"), order("b", "C2"))
	c.confirmErr["a"] = &api.Error{Status: 409, Message: "no confirmable"}
	res, err := run(t, c, &ledger{})
	if err != nil {
		t.Fatalf("un 409 no debe cortar el ciclo: %v", err)
	}
	if res.Created != 2 || res.Confirmed != 1 || c.status["b"] != "synced_to_erp" {
		t.Fatalf("res = %+v", res)
	}
}

func TestUnaClaveRechazadaCortaElCicloSinPerderElPedido(t *testing.T) {
	c := newCloud(order("a", "C1"))
	c.confirmErr["a"] = &api.Error{Status: 401, Message: "clave falsa"}
	if _, err := run(t, c, &ledger{}); err == nil || c.status["a"] != "pending_sync" {
		t.Fatalf("err = %v estado = %s", err, c.status["a"])
	}
}

func TestSiLaNubeFallaNoSeEscribeNada(t *testing.T) {
	c := newCloud(order("a", "C1"))
	c.pendingErr = &api.Error{Status: 0, Message: "sin red"}
	w := &ledger{}
	if _, err := run(t, c, w); err == nil || len(w.calls) != 0 {
		t.Fatalf("err = %v, llamadas = %d", err, len(w.calls))
	}
}
