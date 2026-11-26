// Package config carga y valida la configuración del agente desde un archivo
// YAML. Los secretos (x-api-key, DSN del ERP) pueden venir del entorno para no
// dejarlos en disco: ERP_AGENT_API_KEY y ERP_AGENT_SAINT_DSN tienen prioridad
// sobre el archivo.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config es la configuración completa del agente.
type Config struct {
	API       API       `yaml:"api"`
	ERP       ERP       `yaml:"erp"`
	Sync      Sync      `yaml:"sync"`
	Store     Store     `yaml:"store"`
	Heartbeat Heartbeat `yaml:"heartbeat"`
	Orders    Orders    `yaml:"orders"`
	Log       Log       `yaml:"log"`
}

// API: a dónde se envían los datos.
type API struct {
	URL    string `yaml:"url"`
	APIKey string `yaml:"api_key"`
}

// ERP: de dónde se leen los datos.
type ERP struct {
	Type  string `yaml:"type"` // saint | mock
	Saint Saint  `yaml:"saint"`
	Mock  Mock   `yaml:"mock"`
}

// Saint: conexión a SQL Server y archivo de mapeo de columnas.
type Saint struct {
	DSN         string `yaml:"dsn"`
	MappingFile string `yaml:"mapping_file"`
}

// Mock: tamaño de los datos simulados.
type Mock struct {
	Products  int   `yaml:"products"`
	Customers int   `yaml:"customers"`
	Seed      int64 `yaml:"seed"`
}

// Sync: cada cuánto se lee el ERP.
type Sync struct {
	Interval          time.Duration `yaml:"interval"`           // ciclo delta
	ReconcileInterval time.Duration `yaml:"reconcile_interval"` // reconciliación completa; 0 = desactivada
}

// Store: ruta de la base SQLite local (huellas y cola).
type Store struct {
	Path string `yaml:"path"`
}

// Heartbeat: cada cuánto se avisa a la API que el agente sigue vivo.
type Heartbeat struct {
	Interval time.Duration `yaml:"interval"`
}

// Orders: llevar los pedidos web al ERP como borradores (en cada ciclo de sincronización).
type Orders struct {
	Enabled bool `yaml:"enabled"`
	Limit   int  `yaml:"limit"` // pedidos pendientes que se piden por ciclo (1 a 500)
}

// Log: nivel y formato de los logs (siempre a stderr).
type Log struct {
	Level  string `yaml:"level"`  // debug | info | warn | error
	Format string `yaml:"format"` // json | text
}

// Defaults devuelve la configuración con los valores por defecto.
func Defaults() Config {
	return Config{
		ERP:       ERP{Mock: Mock{Products: 50, Customers: 10, Seed: 1}},
		Sync:      Sync{Interval: 30 * time.Second, ReconcileInterval: 24 * time.Hour},
		Store:     Store{Path: "agent.db"},
		Heartbeat: Heartbeat{Interval: time.Minute},
		Orders:    Orders{Enabled: true, Limit: 50},
		Log:       Log{Level: "info", Format: "json"},
	}
}

// Load lee el archivo, aplica defaults y entorno, resuelve las rutas
// relativas respecto a la carpeta del archivo y valida.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	cfg, err := Parse(raw, os.Getenv)
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(path)
	cfg.Store.Path = rel(dir, cfg.Store.Path)
	if cfg.ERP.Saint.MappingFile != "" {
		cfg.ERP.Saint.MappingFile = rel(dir, cfg.ERP.Saint.MappingFile)
	}
	return cfg, nil
}

func rel(dir, p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(dir, p)
}

// Parse interpreta el YAML (estricto: un campo desconocido es un error, para
// atrapar erratas como "intervall"), aplica defaults y entorno y valida.
func Parse(data []byte, getenv func(string) string) (*Config, error) {
	cfg := Defaults()
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("config: %w", err)
	}
	if v := getenv("ERP_AGENT_API_KEY"); v != "" {
		cfg.API.APIKey = v
	}
	if v := getenv("ERP_AGENT_SAINT_DSN"); v != "" {
		cfg.ERP.Saint.DSN = v
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// Validate reúne TODOS los problemas en un solo error.
func (c *Config) Validate() error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	u, err := url.Parse(c.API.URL)
	switch {
	case c.API.URL == "":
		bad("api.url es obligatoria")
	case err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http"):
		bad("api.url inválida: %q (debe ser http(s)://host)", c.API.URL)
	case u.Scheme == "http" && !isLoopback(u.Hostname()):
		bad("api.url debe ser https (http solo se admite hacia localhost)")
	}
	if strings.TrimSpace(c.API.APIKey) == "" {
		bad("api.api_key es obligatoria (o la variable ERP_AGENT_API_KEY)")
	}

	switch c.ERP.Type {
	case "saint":
		if c.ERP.Saint.DSN == "" {
			bad("erp.saint.dsn es obligatoria (o la variable ERP_AGENT_SAINT_DSN)")
		}
		if c.ERP.Saint.MappingFile == "" {
			bad("erp.saint.mapping_file es obligatoria")
		}
	case "mock":
		if c.ERP.Mock.Products < 0 || c.ERP.Mock.Customers < 0 {
			bad("erp.mock: las cantidades no pueden ser negativas")
		}
	case "":
		bad("erp.type es obligatorio (saint | mock)")
	default:
		bad("erp.type desconocido: %q (saint | mock)", c.ERP.Type)
	}

	if c.Sync.Interval < time.Second {
		bad("sync.interval debe ser de al menos 1s (es %s)", c.Sync.Interval)
	}
	if c.Sync.ReconcileInterval != 0 && c.Sync.ReconcileInterval < time.Minute {
		bad("sync.reconcile_interval debe ser 0 (desactivada) o de al menos 1m (es %s)", c.Sync.ReconcileInterval)
	}
	if c.Heartbeat.Interval < 5*time.Second {
		bad("heartbeat.interval debe ser de al menos 5s (es %s)", c.Heartbeat.Interval)
	}
	if c.Orders.Limit < 1 || c.Orders.Limit > 500 {
		bad("orders.limit debe estar entre 1 y 500 (es %d)", c.Orders.Limit)
	}
	if strings.TrimSpace(c.Store.Path) == "" {
		bad("store.path es obligatoria")
	}
	switch strings.ToLower(c.Log.Level) {
	case "debug", "info", "warn", "error":
	default:
		bad("log.level inválido: %q (debug | info | warn | error)", c.Log.Level)
	}
	switch strings.ToLower(c.Log.Format) {
	case "json", "text":
	default:
		bad("log.format inválido: %q (json | text)", c.Log.Format)
	}
	return errors.Join(errs...)
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
