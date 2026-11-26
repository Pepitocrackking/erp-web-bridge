package sender

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
)

// fakeAPI imita lo esencial de la API real: autenticación por x-api-key,
// idempotencia por batch_id (duplicate=true) y fallos programables.
type fakeAPI struct {
	mu       sync.Mutex
	srv      *httptest.Server
	seen     map[string]bool // batch_id ya procesados
	received []string        // batch_id en orden de llegada (sin duplicados)
	hits     int
	apiKey   string
	mode     func(batchID string, hit int) (status int, header http.Header) // nil = todo bien
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{seen: map[string]bool{}, apiKey: "k"}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits++
	if r.Header.Get("x-api-key") != f.apiKey {
		w.WriteHeader(401)
		io.WriteString(w, `{"message":"clave inválida"}`)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	var b struct {
		BatchID string `json:"batch_id"`
		OrgID   string `json:"org_id"`
	}
	json.Unmarshal(raw, &b)
	if b.OrgID != "" {
		w.WriteHeader(400)
		return
	}
	if f.mode != nil {
		if status, h := f.mode(b.BatchID, f.hits); status != 0 {
			for k, v := range h {
				w.Header()[k] = v
			}
			w.WriteHeader(status)
			io.WriteString(w, `{"message":["registro inválido","otro"]}`)
			return
		}
	}
	dup := f.seen[b.BatchID]
	if !dup {
		f.seen[b.BatchID] = true
		f.received = append(f.received, b.BatchID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"batch_id": b.BatchID, "duplicate": dup, "received": 1, "inserted": nil, "updated": nil, "unchanged": nil, "deactivated": nil})
}

type fx struct {
	api *fakeAPI
	st  *store.Store
	cl  *api.Client
	snd *Sender
}

func setup(t *testing.T) *fx {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	a := newFakeAPI(t)
	cl := api.New(a.srv.URL, "k", "test")
	return &fx{api: a, st: st, cl: cl, snd: &Sender{Store: st, Client: cl}}
}

func (f *fx) enqueue(t *testing.T, id string, fps map[string]string) store.Entry {
	t.Helper()
	e := store.Entry{BatchID: id, Kind: store.KindProducts, Records: len(fps), Body: []byte(`{"batch_id":"` + id + `"}`), Commit: store.Commit{Fingerprints: fps}}
	if err := f.st.Enqueue(context.Background(), []store.Entry{e}); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestEntregaVaciaLaColaEnOrdenYGuardaHuellas(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.enqueue(t, "b1", map[string]string{"P1": "a"})
	f.enqueue(t, "b2", map[string]string{"P2": "b"})
	f.enqueue(t, "b3", map[string]string{"P3": "c"})

	res, err := f.snd.Drain(ctx)
	if err != nil || res.Sent != 3 {
		t.Fatalf("%+v %v", res, err)
	}
	if got := f.api.received; len(got) != 3 || got[0] != "b1" || got[1] != "b2" || got[2] != "b3" {
		t.Fatalf("orden de llegada = %v", got)
	}
	if n, _ := f.st.Depth(ctx); n != 0 {
		t.Fatalf("depth = %d", n)
	}
	if fps, _ := f.st.Fingerprints(ctx, store.KindProducts); len(fps) != 3 {
		t.Fatalf("huellas = %v", fps)
	}
	if f.snd.LastError() != "" {
		t.Fatalf("LastError = %q", f.snd.LastError())
	}
}

// Corte de red: ningún lote se pierde, el orden se mantiene y al volver todo llega.
func TestCorteDeRedNoPierdeDatosYSePoneAlDia(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.enqueue(t, "b1", map[string]string{"P1": "a"})
	f.enqueue(t, "b2", map[string]string{"P2": "b"})

	f.api.mode = func(string, int) (int, http.Header) { return 503, nil } // la API / la red caen
	res, err := f.snd.Drain(ctx)
	var re *RetryError
	if !errors.As(err, &re) || res.Sent != 0 {
		t.Fatalf("debía ser RetryError: %+v %v", res, err)
	}
	if n, _ := f.st.Depth(ctx); n != 2 {
		t.Fatalf("depth = %d: no se debe perder nada", n)
	}
	if len(f.api.received) != 0 {
		t.Fatal("la API caída no recibió nada")
	}
	if first, _ := f.st.Next(ctx); first.BatchID != "b1" || first.Attempts != 1 {
		t.Fatalf("b1 sigue primero con 1 intento: %+v", first)
	}

	// Mientras tanto se encolan más cambios.
	f.enqueue(t, "b3", map[string]string{"P3": "c"})

	f.api.mode = nil // vuelve la red
	res, err = f.snd.Drain(ctx)
	if err != nil || res.Sent != 3 {
		t.Fatalf("%+v %v", res, err)
	}
	if got := f.api.received; len(got) != 3 || got[0] != "b1" || got[2] != "b3" {
		t.Fatalf("llegada = %v", got)
	}
	if fps, _ := f.st.Fingerprints(ctx, store.KindProducts); len(fps) != 3 {
		t.Fatalf("huellas = %v", fps)
	}
}

func TestRedCaidaDeVerdadDevuelveRetryError(t *testing.T) {
	f := setup(t)
	f.enqueue(t, "b1", nil)
	f.api.srv.Close() // conexión rechazada
	_, err := f.snd.Drain(context.Background())
	var re *RetryError
	if !errors.As(err, &re) {
		t.Fatalf("err = %v", err)
	}
	if n, _ := f.st.Depth(context.Background()); n != 1 {
		t.Fatal("el lote debe seguir en la cola")
	}
}

// El agente murió tras enviar pero antes de anotar la entrega: el reenvío es un duplicado.
func TestReenvioTrasCorteDeLuzEsDuplicado(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	e := f.enqueue(t, "b1", map[string]string{"P1": "a"})
	if _, err := f.cl.SendBatch(ctx, e.Kind, e.Body); err != nil { // el envío llegó…
		t.Fatal(err)
	}
	// …pero el proceso murió antes de Complete: el lote sigue en la cola. Al reiniciar:
	res, err := f.snd.Drain(ctx)
	if err != nil || res.Sent != 1 || res.Duplicates != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if len(f.api.received) != 1 {
		t.Fatalf("la API no debe procesarlo dos veces: %v", f.api.received)
	}
	if fps, _ := f.st.Fingerprints(ctx, store.KindProducts); fps["P1"] != "a" {
		t.Fatal("las huellas deben guardarse igualmente")
	}
}

func TestRateLimitRespetaRetryAfter(t *testing.T) {
	f := setup(t)
	f.enqueue(t, "b1", nil)
	f.api.mode = func(string, int) (int, http.Header) { return 429, http.Header{"Retry-After": {"7"}} }
	_, err := f.snd.Drain(context.Background())
	var re *RetryError
	if !errors.As(err, &re) || re.After != 7*time.Second {
		t.Fatalf("After = %v (%v)", re, err)
	}
	if d := f.snd.delay(0, err); d != 7*time.Second {
		t.Fatalf("delay = %v, quiero 7s", d)
	}
	f.snd.MaxRetryAfter = 3 * time.Second
	if d := f.snd.delay(0, err); d != 3*time.Second {
		t.Fatalf("el tope de Retry-After no se aplicó: %v", d)
	}
}

func TestLoteInvalidoSeDescartaYLosDemasSiguen(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.enqueue(t, "malo", map[string]string{"P1": "a"})
	f.enqueue(t, "bueno", map[string]string{"P2": "b"})
	f.api.mode = func(id string, _ int) (int, http.Header) {
		if id == "malo" {
			return 422, nil
		}
		return 0, nil
	}
	res, err := f.snd.Drain(ctx)
	if err != nil || res.Sent != 1 || res.Discarded != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if fps, _ := f.st.Fingerprints(ctx, store.KindProducts); len(fps) != 1 || fps["P2"] != "b" {
		t.Fatalf("solo deben guardarse las huellas del lote entregado: %v", fps)
	}
	if f.snd.LastError() == "" {
		t.Fatal("el rechazo debe quedar como último error para el heartbeat")
	}
}

func TestConflictoDescartaTodaLaReconciliacionYReplanifica(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.st.SetMeta(ctx, store.MetaLastReconcile(store.KindProducts), "2026-11-26T00:00:00Z")
	mk := func(id string, final bool) store.Entry {
		return store.Entry{BatchID: id, Kind: store.KindProducts, ReconciliationID: "R1", Final: final, Body: []byte(`{"batch_id":"` + id + `"}`)}
	}
	f.st.Enqueue(ctx, []store.Entry{mk("r1", false), mk("r2", false), mk("r3", true)})
	f.enqueue(t, "normal", map[string]string{"P9": "z"})
	f.api.mode = func(id string, _ int) (int, http.Header) {
		if id == "r1" {
			return 409, nil
		}
		return 0, nil
	}
	res, err := f.snd.Drain(ctx)
	if err != nil || res.Discarded != 3 || res.Sent != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if v, _ := f.st.Meta(ctx, store.MetaLastReconcile(store.KindProducts)); v != "" {
		t.Fatal("debe quedar sin marca para replanificar la reconciliación")
	}
}

func TestClaveRechazadaConservaElLote(t *testing.T) {
	f := setup(t)
	f.enqueue(t, "b1", map[string]string{"P1": "a"})
	f.cl.APIKey = "mala"
	_, err := f.snd.Drain(context.Background())
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("err = %v", err)
	}
	if n, _ := f.st.Depth(context.Background()); n != 1 {
		t.Fatal("el lote debe conservarse")
	}
	f.cl.APIKey = "k" // el operador corrige la configuración
	if res, err := f.snd.Drain(context.Background()); err != nil || res.Sent != 1 {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestNuncaSeEnviaOrgID(t *testing.T) {
	f := setup(t)
	f.enqueue(t, "b1", nil)
	f.api.mode = nil
	if res, err := f.snd.Drain(context.Background()); err != nil || res.Sent != 1 {
		t.Fatalf("%+v %v (el fake API responde 400 si ve org_id)", res, err)
	}
}

func TestBackoffCreceConTopeYJitter(t *testing.T) {
	base, max := time.Second, 30*time.Second
	var prev time.Duration
	for i := 0; i < 5; i++ {
		d := Backoff(i, base, max, 0.5) // jitter 0.5 = factor 1.0
		if d <= prev {
			t.Fatalf("intento %d: %v no crece respecto a %v", i, d, prev)
		}
		prev = d
	}
	if got := Backoff(1, base, max, 0.5); got != 2*time.Second {
		t.Fatalf("2^1·1s = %v", got)
	}
	if got := Backoff(50, base, max, 0.5); got != max {
		t.Fatalf("debe toparse en max: %v", got)
	}
	if lo, hi := Backoff(2, base, max, 0), Backoff(2, base, max, 0.9999); lo >= hi || lo != 3200*time.Millisecond {
		t.Fatalf("jitter ±20 %%: %v %v", lo, hi)
	}
}

// Run: tras fallar sigue sola con backoff creciente y, al volver la API, vacía la cola.
func TestRunReintentaConBackoffYSeVaciaSola(t *testing.T) {
	f := setup(t)
	f.enqueue(t, "b1", map[string]string{"P1": "a"})
	fails := 3
	f.api.mode = func(string, int) (int, http.Header) {
		if fails > 0 {
			fails--
			return 502, nil
		}
		return 0, nil
	}
	var delays []time.Duration
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.snd.Jitter = func() float64 { return 0.5 }
	f.snd.Sleep = func(_ context.Context, d time.Duration) error { delays = append(delays, d); return nil }

	kick := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- f.snd.Run(ctx, kick) }()

	deadline := time.After(5 * time.Second)
	for {
		if n, _ := f.st.Depth(context.Background()); n == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("la cola no se vació sola")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run = %v", err)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	if len(delays) != 3 || delays[0] != want[0] || delays[1] != want[1] || delays[2] != want[2] {
		t.Fatalf("esperas = %v, quiero %v", delays, want)
	}
}

func TestRunSeDespiertaConKick(t *testing.T) {
	f := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	kick := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- f.snd.Run(ctx, kick) }()

	f.enqueue(t, "b1", map[string]string{"P1": "a"})
	kick <- struct{}{}
	deadline := time.After(5 * time.Second)
	for {
		if n, _ := f.st.Depth(context.Background()); n == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("kick no despertó al sender")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

func TestClienteClasificaErrores(t *testing.T) {
	for status, want := range map[int]api.Class{
		0: api.Retry, 408: api.Retry, 429: api.Retry, 500: api.Retry, 503: api.Retry,
		400: api.Invalid, 413: api.Invalid, 422: api.Invalid, 404: api.Invalid,
		409: api.Conflict, 401: api.Auth, 403: api.Auth,
	} {
		if got := (&api.Error{Status: status}).Class(); got != want {
			t.Errorf("HTTP %d: clase %v, quiero %v", status, got, want)
		}
	}
	if api.Classify(context.DeadlineExceeded) != api.Retry {
		t.Error("errores ajenos a la API se reintentan")
	}
}

func TestMensajeDeErrorDeNestSeLee(t *testing.T) {
	f := setup(t)
	f.enqueue(t, "b1", nil)
	f.api.mode = func(string, int) (int, http.Header) { return 422, nil }
	f.snd.Drain(context.Background())
	if got := f.snd.LastError(); got == "" || !strings.Contains(got, "registro inválido; otro") {
		t.Fatalf("LastError = %q", got)
	}
}
