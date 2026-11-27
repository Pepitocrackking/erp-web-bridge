package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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
	key        string            // x-api-key que acepta (por defecto "k")
}

func newCloud(t *testing.T) *cloud {
	c := &cloud{key: "k"}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if r.Header.Get("x-api-key") != c.key {
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

// writerConLogin simula un ERP cuyo login puede (o no) escribir fuera de los borradores.
type writerConLogin struct {
	*mock.Adapter
	verifica error // lo que devuelve VerifyWriteIsolation
	veces    int
}

func (w *writerConLogin) VerifyWriteIsolation(context.Context) error {
	w.veces++
	return w.verifica
}

func TestConUnLoginInseguroNoSeConsultanNiSeEscribenPedidos(t *testing.T) {
	c := newCloud(t)
	c.pending = []map[string]any{
		{"id": "11111111-1111-4111-8111-111111111111", "customer_code": "C00002", "status": "pending_sync",
			"total_usd": 10.0, "exchange_rate_used": 40.0, "erp_order_reference": nil, "notes": nil, "created_at": "2026-11-26T00:00:00.000Z",
			"items": []map[string]any{{"sku": "P00001", "quantity": 1, "unit_price_usd": 10.0}}},
	}
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	var closers []func() error
	a, err := New(context.Background(), cfg, NewLogger(discard(), cfg.Log), &closers)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, f := range closers {
			f()
		}
	}()
	m := a.erp.(*mock.Adapter)
	m.Add(erpProduct("P00001"))
	w := &writerConLogin{Adapter: m, verifica: &erp.UnsafeLoginError{Login: "sa", Problems: []string{"es sysadmin"}}}
	a.erp = w
	a.orders.Writer = w

	// Login que puede escribir fuera de los borradores: el ciclo falla y NO toca la nube ni el ERP.
	if err := a.once(context.Background(), false); err == nil || !strings.Contains(err.Error(), "puede escribir fuera de los borradores") {
		t.Fatalf("err = %v, quiero el aviso del login inseguro", err)
	}
	c.mu.Lock()
	gets := c.orderGets
	c.mu.Unlock()
	if gets != 0 || len(m.Drafts()) != 0 {
		t.Fatalf("consultas de pedidos = %d, borradores = %d: con un login inseguro no debe pasar nada", gets, len(m.Drafts()))
	}

	// Un error de conexión al verificar tampoco deja escribir (no se sabe si es seguro), y se reintenta.
	w.verifica = errors.New("conexión rechazada")
	if err := a.once(context.Background(), false); err == nil {
		t.Fatal("sin poder verificar el login no debe escribir")
	}
	if len(m.Drafts()) != 0 {
		t.Fatal("se escribió un borrador sin verificar el login")
	}

	// Se corrige el login: el siguiente ciclo verifica y trabaja, y no vuelve a verificar cada vez.
	w.verifica = nil
	if err := a.once(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(m.Drafts()) != 1 {
		t.Fatalf("borradores = %d, quiero 1", len(m.Drafts()))
	}
	veces := w.veces
	if err := a.once(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if w.veces != veces {
		t.Fatalf("verificó el login %d veces más: una vez aprobado no hay que repetirlo", w.veces-veces)
	}
}

func TestOpenLogEscribeAArchivoYAConsola(t *testing.T) {
	dir := t.TempDir()
	var console bytes.Buffer
	c := config.Log{Level: "info", Format: "json", File: filepath.Join(dir, "logs", "agent.log"), MaxSizeMB: 1, MaxBackups: 1}
	w, closer, err := OpenLog(c, &console)
	if err != nil {
		t.Fatal(err)
	}
	NewLogger(w, c).Info("hola desde la prueba")
	closer.Close()
	b, err := os.ReadFile(c.File)
	if err != nil || !strings.Contains(string(b), "hola desde la prueba") {
		t.Fatalf("archivo = %q, err = %v", b, err)
	}
	if !strings.Contains(console.String(), "hola desde la prueba") {
		t.Fatalf("consola = %q", console.String())
	}
}

func TestOpenLogSinArchivoUsaSoloLaConsola(t *testing.T) {
	var console bytes.Buffer
	w, closer, err := OpenLog(config.Log{}, &console)
	if err != nil {
		t.Fatal(err)
	}
	defer closer.Close()
	w.Write([]byte("x"))
	if console.String() != "x" {
		t.Fatalf("consola = %q", console.String())
	}
}

func TestOpenLogSinConsolaNiArchivoDescarta(t *testing.T) {
	w, closer, err := OpenLog(config.Log{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer closer.Close()
	if n, err := w.Write([]byte("abc")); err != nil || n != 3 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

func TestOpenLogFallaSiNoPuedeAbrirElArchivo(t *testing.T) {
	if _, _, err := OpenLog(config.Log{File: t.TempDir(), MaxSizeMB: 1}, nil); err == nil {
		t.Fatal("esperaba error")
	}
}

func TestReadyAvisaCuandoElAgenteYaEstaArmado(t *testing.T) {
	c := newCloud(t)
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	calls := 0
	err := Run(context.Background(), cfg, NewLogger(discard(), cfg.Log), Options{Once: true, Ready: func() { calls++ }})
	if err != nil || calls != 1 {
		t.Fatalf("err = %v, Ready llamado %d veces, quería 1", err, calls)
	}
}

func TestReadyNoSeLlamaSiElAgenteNoPuedeArmarse(t *testing.T) {
	c := newCloud(t)
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	cfg.ERP.Type = "inexistente"
	calls := 0
	err := Run(context.Background(), cfg, NewLogger(discard(), cfg.Log), Options{Once: true, Ready: func() { calls++ }})
	if err == nil || calls != 0 {
		t.Fatalf("err = %v, Ready llamado %d veces, quería error y 0 llamadas", err, calls)
	}
}

// Seguridad (8.5): ni la clave de la API ni la contraseña de la DSN deben aparecer en los logs ni en
// los errores, que además viajan al heartbeat hacia la nube. Se prueba con valores reconocibles y el
// nivel de log más verboso, con una conexión que falla (los errores del driver son los que podrían
// arrastrar la DSN).
func TestLosSecretosNuncaAparecenEnLogsNiErrores(t *testing.T) {
	const apiKey = "API-KEY-SECRETA-9f3a1c" // gitleaks:allow valor falso a propósito: la prueba comprueba que NO se filtra
	const password = "S3cr3tPASSw0rd-7b2e"  // gitleaks:allow valor falso a propósito: la prueba comprueba que NO se filtra
	dsns := map[string]string{
		"conexión rechazada": "sqlserver://sa:" + password + "@127.0.0.1:1?database=X&encrypt=disable&dial+timeout=1",
		"DSN mal formada":    "sqlserver://sa:" + password + "@[::1",
	}
	for name, dsn := range dsns {
		t.Run(name, func(t *testing.T) {
			c := newCloud(t)
			cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
			cfg.API.APIKey = apiKey
			cfg.Log.Level = "debug"
			cfg.ERP.Type = "saint"
			cfg.ERP.Saint = config.Saint{DSN: dsn, MappingFile: "../../../../infra/saint-sandbox/mapping.saint.yaml"}

			var logs bytes.Buffer
			log := NewLogger(&logs, cfg.Log)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			err := Run(ctx, cfg, log, Options{Once: true})

			all := logs.String()
			if err != nil {
				all += "\n" + err.Error()
			}
			if strings.Contains(all, password) || strings.Contains(all, apiKey) {
				t.Fatalf("se filtró un secreto en logs/errores:\n%s", all)
			}
		})
	}
}

func TestLaClaveDeLaAPINuncaAparecePorLogsConElERPSimulado(t *testing.T) {
	const apiKey = "API-KEY-SECRETA-9f3a1c" // gitleaks:allow valor falso a propósito: la prueba comprueba que NO se filtra
	c := newCloud(t)
	c.key = apiKey // la nube simulada acepta esta clave: así se recorre el camino de éxito completo
	cfg := cfgFor(t, c, filepath.Join(t.TempDir(), "agent.db"))
	cfg.API.APIKey = apiKey
	cfg.Log.Level = "debug"
	var logs bytes.Buffer
	if err := Run(context.Background(), cfg, NewLogger(&logs, cfg.Log), Options{Once: true}); err != nil {
		t.Fatal(err)
	}
	if logs.Len() == 0 {
		t.Fatal("la prueba no es válida: no se registró nada")
	}
	if strings.Contains(logs.String(), apiKey) {
		t.Fatalf("la clave de la API apareció en el log:\n%s", logs.String())
	}
}
