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
)

type cloud struct {
	mu         sync.Mutex
	srv        *httptest.Server
	batches    []map[string]any
	heartbeats []map[string]any
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
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(raw, &m)
		w.Header().Set("Content-Type", "application/json")
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
