package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/config"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp/mock"
)

type cloud struct {
	mu         sync.Mutex
	srv        *httptest.Server
	batches    []map[string]any
	heartbeats []map[string]any
	pending    []map[string]any // pedidos que devuelve GET /v1/orders/pending
	orderGets  int
	confirmed  map[string]string // id del pedido -> referencia con la que se confirmó
	failed     map[string]string // id del pedido -> motivo informado
}

func newCloud(t *testing.T) *cloud {
	c := &cloud{}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if r.Header.Get("x-api-key") != "k" {
			w.WriteHeader(401)
			return
		}
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/orders/pending") {
			c.orderGets++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"orders": append([]map[string]any{}, c.pending...)})
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(raw, &m)
		w.Header().Set("Content-Type", "application/json")
		if parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/"); len(parts) == 4 && parts[1] == "orders" {
			id, action := parts[2], parts[3]
			if c.confirmed == nil {
				c.confirmed, c.failed = map[string]string{}, map[string]string{}
			}
			if action == "confirm" {
				c.confirmed[id], _ = m["erp_order_reference"].(string)
			} else {
				c.failed[id], _ = m["error_detail"].(string)
			}
			kept := c.pending[:0:0]
			for _, o := range c.pending { // ya no está pendiente
				if o["id"] != id {
					kept = append(kept, o)
				}
			}
			c.pending = kept
			json.NewEncoder(w).Encode(map[string]any{"id": id, "status": "synced_to_erp", "erp_order_reference": m["erp_order_reference"], "duplicate": false})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			c.heartbeats = append(c.heartbeats, m)
			io.WriteString(w, `{"ok":true,"server_time":"2026-11-26T00:00:00.000Z"}`)
			return
		}
		c.batches = append(c.batches, m)
		json.NewEncoder(w).Encode(map[string]any{"batch_id": m["batch_id"], "duplicate": false, "received": 1, "inserted": 1, "updated": 0, "unchanged": 0, "deactivated": 0})
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *cloud) counts() (batches, heartbeats int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.batches), len(c.heartbeats)
}

func cfgFor(t *testing.T, c *cloud, dbPath string) *config.Config {
	cfg := config.Defaults()
	cfg.API = config.API{URL: c.srv.URL, APIKey: "k"}
	cfg.ERP.Type = "mock"
	cfg.ERP.Mock = config.Mock{Products: 30, Customers: 4, Seed: 1}
	cfg.Store.Path = dbPath
	return &cfg
}

func erpProduct(sku string) erp.Product {
	return erp.Product{SKU: sku, Name: "PRODUCTO DE PRUEBA", PriceUSD: 10, Stock: 100, Active: true}
}

func discard() *bytes.Buffer { return &bytes.Buffer{} }

func TestOnceSincronizaYNoRepiteSinCambios(t *testing.T) {
	c := newCloud(t)
	db := filepath.Join(t.TempDir(), "agent.db")
	cfg := cfgFor(t, c, db)
	log := NewLogger(discard(), cfg.Log)

	if err := Run(context.Background(), cfg, log, Options{Once: true}); err != nil {
		t.Fatal(err)
	}
	if b, _ := c.counts(); b != 2 { // reconciliación de productos + de clientes
		t.Fatalf("lotes = %d, quiero 2", b)
	}
	// Segunda ejecución con la misma base local: nada cambió y no toca reconciliar.
	if err := Run(context.Background(), cfg, log, Options{Once: true}); err != nil {
		t.Fatal(err)
	}
	if b, _ := c.counts(); b != 2 {
		t.Fatalf("lotes = %d: sin cambios no debe enviarse nada", b)
	}
	// Forzar la reconciliación sí envía.
	if err := Run(context.Background(), cfg, log, Options{Once: true, Reconcile: true}); err != nil {
		t.Fatal(err)
	}
	if b, _ := c.counts(); b != 4 {
		t.Fatalf("lotes = %d, quiero 4", b)
	}
}

func TestLoopEnviaHeartbeatYSeApagaLimpio(t *testing.T) {
	c := newCloud(t)
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	cfg.Sync.Interval = 50 * time.Millisecond
	cfg.Heartbeat.Interval = 50 * time.Millisecond
	log := NewLogger(discard(), cfg.Log)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg, log, Options{}) }()

	deadline := time.After(10 * time.Second)
	for {
		b, h := c.counts()
		if b >= 2 && h >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("no llegaron lotes/heartbeats: %d %d", b, h)
		case <-time.After(20 * time.Millisecond):
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("el apagado debe ser limpio: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("el agente no se apagó")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	hb := c.heartbeats[0]
	if hb["agent_version"] == "" || hb["agent_version"] == nil {
		t.Fatalf("heartbeat = %v", hb)
	}
	if _, ok := hb["queue_depth"]; !ok {
		t.Fatalf("el heartbeat debe informar queue_depth: %v", hb)
	}
	for _, b := range c.batches {
		if _, ok := b["org_id"]; ok {
			t.Fatal("nunca se envía org_id")
		}
	}
}

func TestOnceConClaveMalaFallaYConservaLaCola(t *testing.T) {
	c := newCloud(t)
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	cfg.API.APIKey = "mala"
	log := NewLogger(discard(), cfg.Log)
	if err := Run(context.Background(), cfg, log, Options{Once: true}); err == nil {
		t.Fatal("con una clave rechazada debe fallar")
	}
}

func TestLoggerEsJSONConVersionYRespetaElNivel(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf, config.Log{Level: "warn", Format: "json"})
	log.Info("no sale")
	log.Warn("sale", "clave", 1)
	line := strings.TrimSpace(buf.String())
	if strings.Contains(line, "no sale") || strings.Count(line, "\n") != 0 {
		t.Fatalf("salida = %q", line)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("no es JSON: %v", err)
	}
	if m["msg"] != "sale" || m["level"] != "WARN" || m["agent_version"] == nil || m["clave"] != float64(1) {
		t.Fatalf("log = %v", m)
	}
}

func TestOnceLlevaLosPedidosPendientesAlERPComoBorradores(t *testing.T) {
	c := newCloud(t)
	c.pending = []map[string]any{
		{"id": "11111111-1111-4111-8111-111111111111", "customer_code": "C00002", "status": "pending_sync",
			"total_usd": 20.0, "exchange_rate_used": 40.0, "erp_order_reference": nil, "notes": nil, "created_at": "2026-11-26T00:00:00.000Z",
			"items": []map[string]any{{"sku": "P00001", "quantity": 2, "unit_price_usd": 10.0}}},
		{"id": "22222222-2222-4222-8222-222222222222", "customer_code": "NO-EXISTE", "status": "pending_sync",
			"total_usd": 5.0, "exchange_rate_used": 40.0, "erp_order_reference": nil, "notes": nil, "created_at": "2026-11-26T00:00:01.000Z",
			"items": []map[string]any{{"sku": "P00001", "quantity": 1, "unit_price_usd": 5.0}}},
	}
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	cfg.ERP.Mock.Customers = 10 // C00002 existe; si por azar está inactivo el test lo avisa abajo
	log := NewLogger(discard(), cfg.Log)

	var closers []func() error
	a, err := New(context.Background(), cfg, log, &closers)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, f := range closers {
			f()
		}
	}()
	m := a.erp.(*mock.Adapter)
	m.Add(erpProduct("P00001")) // activo seguro
	if err := a.once(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	// El segundo ciclo ya no ve pedidos pendientes: nada nuevo, nada duplicado.
	if err := a.once(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	drafts := m.Drafts()
	if len(drafts) != 1 || drafts[0].Order.CustomerCode != "C00002" || drafts[0].Order.Lines[0].Quantity != 2 {
		t.Fatalf("borradores = %+v, quiero 1 (el del cliente que existe) sin duplicar", drafts)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.orderGets < 2 {
		t.Fatalf("consultas de pedidos = %d, quiero una por ciclo", c.orderGets)
	}
	// El pedido bueno se confirmó con la referencia del borrador; el del cliente inexistente se informó como error.
	if got := c.confirmed["11111111-1111-4111-8111-111111111111"]; got != drafts[0].Reference {
		t.Fatalf("confirmado con %q, la referencia del borrador es %q", got, drafts[0].Reference)
	}
	if got := c.failed["22222222-2222-4222-8222-222222222222"]; !strings.Contains(got, "NO-EXISTE") {
		t.Fatalf("motivo informado = %q, quiero que nombre al cliente inexistente", got)
	}
	if len(c.confirmed) != 1 || len(c.failed) != 1 {
		t.Fatalf("confirmados = %v, fallidos = %v", c.confirmed, c.failed)
	}
}

func TestPedidosDesactivadosNoConsultanLaNube(t *testing.T) {
	c := newCloud(t)
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	cfg.Orders.Enabled = false
	log := NewLogger(discard(), cfg.Log)
	if err := Run(context.Background(), cfg, log, Options{Once: true}); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.orderGets != 0 {
		t.Fatalf("consultas de pedidos = %d, quiero 0", c.orderGets)
	}
}
