package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func noEnv(string) string { return "" }

const minimo = `
api:
  url: https://api.ejemplo.com
  api_key: secreta
erp:
  type: mock
`

func TestMinimoUsaDefaults(t *testing.T) {
	c, err := Parse([]byte(minimo), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if c.Sync.Interval != 30*time.Second || c.Sync.ReconcileInterval != 24*time.Hour || c.Heartbeat.Interval != time.Minute ||
		c.Store.Path != "agent.db" || c.Log.Format != "json" || c.ERP.Mock.Products != 50 {
		t.Fatalf("defaults = %+v", c)
	}
}

func TestSaintCompletoYDuraciones(t *testing.T) {
	c, err := Parse([]byte(`
api: {url: "https://x.com", api_key: k}
erp:
  type: saint
  saint:
    dsn: "sqlserver://sa:pw@localhost:1433?database=SAINT"
    mapping_file: mapping.saint.yaml
sync: {interval: 45s, reconcile_interval: 6h}
heartbeat: {interval: 2m}
log: {level: DEBUG, format: text}
`), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if c.Sync.Interval != 45*time.Second || c.Sync.ReconcileInterval != 6*time.Hour || c.Heartbeat.Interval != 2*time.Minute {
		t.Fatalf("duraciones = %+v %+v", c.Sync, c.Heartbeat)
	}
}

func TestEntornoTienePrioridadParaSecretos(t *testing.T) {
	env := map[string]string{"ERP_AGENT_API_KEY": "del-entorno", "ERP_AGENT_SAINT_DSN": "sqlserver://e"}
	c, err := Parse([]byte(`
api: {url: "https://x.com"}
erp: {type: saint, saint: {mapping_file: m.yaml}}
`), func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if c.API.APIKey != "del-entorno" || c.ERP.Saint.DSN != "sqlserver://e" {
		t.Fatalf("%+v", c)
	}
}

func TestErroresSeReunenTodosJuntos(t *testing.T) {
	_, err := Parse([]byte(`
api: {url: "http://api.ejemplo.com"}
erp: {type: oracle}
sync: {interval: 100ms, reconcile_interval: 10s}
heartbeat: {interval: 1s}
log: {level: ruidoso, format: xml}
`), noEnv)
	if err == nil {
		t.Fatal("esperaba errores")
	}
	for _, frag := range []string{"https", "api_key", "erp.type desconocido", "sync.interval", "reconcile_interval", "heartbeat.interval", "log.level", "log.format"} {
		if !strings.Contains(err.Error(), frag) {
			t.Errorf("falta el aviso sobre %q en:\n%v", frag, err)
		}
	}
}

func TestHTTPSoloHaciaLocalhost(t *testing.T) {
	ok := "api: {url: \"http://localhost:3001\", api_key: k}\nerp: {type: mock}\n"
	if _, err := Parse([]byte(ok), noEnv); err != nil {
		t.Fatalf("http a localhost debe admitirse: %v", err)
	}
	if _, err := Parse([]byte(strings.Replace(ok, "localhost:3001", "10.0.0.5:3001", 1)), noEnv); err == nil {
		t.Fatal("http hacia una IP de red debe rechazarse")
	}
}

func TestCampoDesconocidoEsError(t *testing.T) {
	_, err := Parse([]byte(minimo+"sync:\n  intervall: 10s\n"), noEnv)
	if err == nil || !strings.Contains(err.Error(), "intervall") {
		t.Fatalf("debía señalar la errata: %v", err)
	}
}

func TestReconciliacionDesactivable(t *testing.T) {
	c, err := Parse([]byte(minimo+"sync:\n  reconcile_interval: 0s\n"), noEnv)
	if err != nil || c.Sync.ReconcileInterval != 0 {
		t.Fatalf("%v %+v", err, c)
	}
}

func TestLoadResuelveRutasRelativasRespectoAlArchivo(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	os.WriteFile(path, []byte(`
api: {url: "https://x.com", api_key: k}
erp: {type: saint, saint: {dsn: "sqlserver://x", mapping_file: maps/saint.yaml}}
store: {path: datos/agent.db}
`), 0o600)
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Store.Path != filepath.Join(dir, "datos", "agent.db") || c.ERP.Saint.MappingFile != filepath.Join(dir, "maps", "saint.yaml") {
		t.Fatalf("rutas = %q %q", c.Store.Path, c.ERP.Saint.MappingFile)
	}
	if _, err := Load(filepath.Join(dir, "no-existe.yaml")); err == nil {
		t.Fatal("esperaba error por archivo inexistente")
	}
}

func TestArchivoVacioFallaPorFaltasObligatorias(t *testing.T) {
	if _, err := Parse(nil, noEnv); err == nil {
		t.Fatal("un archivo vacío no es una configuración válida")
	}
}

// El ejemplo documentado debe seguir siendo una configuración válida.
func TestElEjemploDocumentadoEsValido(t *testing.T) {
	c, err := Load("../../agent.example.yaml")
	if err != nil {
		t.Fatalf("agent.example.yaml no pasa la validación: %v", err)
	}
	if c.ERP.Type != "saint" || c.Sync.Interval != 30*time.Second {
		t.Fatalf("%+v", c)
	}
}
