package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/config"
)

func noEnv(string) string { return "" }

func writeCfg(t *testing.T, dir, extra string) string {
	t.Helper()
	p := filepath.Join(dir, "agent.yaml")
	body := "api: {url: \"https://api.ejemplo.com\", api_key: secreta}\nerp: {type: mock}\n" + extra
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestServiceSinAccionMuestraAyuda(t *testing.T) {
	var out, errb bytes.Buffer
	if code := serviceCmd(nil, noEnv, &out, &errb); code != 2 || !strings.Contains(errb.String(), "install") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
}

func TestServiceAccionDesconocida(t *testing.T) {
	var out, errb bytes.Buffer
	if code := serviceCmd([]string{"reiniciar"}, noEnv, &out, &errb); code != 2 || !strings.Contains(errb.String(), "desconocida") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
}

func TestInstallSinConfigFalla(t *testing.T) {
	var out, errb bytes.Buffer
	if code := serviceCmd([]string{"install"}, noEnv, &out, &errb); code == 0 || !strings.Contains(errb.String(), "-config") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
}

// Una configuración inválida debe rechazarse ANTES de tocar el sistema, también sin privilegios.
func TestInstallConConfigInvalidaNoInstalaNada(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.yaml")
	os.WriteFile(p, []byte("api: {url: \"http://remoto.com\"}\nerp: {type: raro}\n"), 0o600)
	var out, errb bytes.Buffer
	code := serviceCmd([]string{"install", "-config", p, "-name", "ErpAgentPruebaInvalida"}, noEnv, &out, &errb)
	if code != 1 || !strings.Contains(errb.String(), "no es válida") || !strings.Contains(errb.String(), "api.url") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
	if strings.Contains(out.String(), "instalado") {
		t.Fatalf("no debe decir que instaló: %q", out.String())
	}
}

func TestInstallOptionsCalculaLasCarpetasDeDatos(t *testing.T) {
	dir := t.TempDir()
	p := writeCfg(t, dir, "store: {path: data/agent.db}\n")
	o, err := installOptions("X", p, "LocalService", "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, "data")}
	if len(o.DataDirs) != 1 || o.DataDirs[0] != want[0] || o.ConfigPath != p || o.Name != "X" {
		t.Fatalf("opts = %+v", o)
	}
	// Con el log en otra carpeta hay dos.
	p = writeCfg(t, dir, "store: {path: data/agent.db}\nlog: {file: logs/agent.log}\n")
	o, err = installOptions("X", p, "LocalService", "")
	if err != nil || len(o.DataDirs) != 2 || o.DataDirs[1] != filepath.Join(dir, "logs") {
		t.Fatalf("err=%v dirs=%v", err, o.DataDirs)
	}
}

func TestLogDelServicioPorDefectoVaJuntoALaBase(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load(writeCfg(t, dir, "store: {path: data/agent.db}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := serviceLogFile(cfg), filepath.Join(dir, "data", "erp-agent.log"); got != want {
		t.Fatalf("log = %q, quería %q", got, want)
	}
	cfg.Log.File = filepath.Join(dir, "otro.log")
	if serviceLogFile(cfg) != cfg.Log.File {
		t.Fatal("un log configurado debe respetarse")
	}
}
