// Package api es el cliente HTTPS del agente hacia la API de la nube. Solo
// hace conexiones salientes (el agente nunca abre puertos).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
)

// Class dice qué hacer ante un error.
type Class int

const (
	// Retry: red caída, 5xx, 408 o 429. Se reintenta el MISMO lote con backoff.
	Retry Class = iota
	// Invalid: la API rechazó el lote (400, 413, 422): reenviarlo igual no sirve. Se descarta.
	Invalid
	// Conflict: 409, reconciliación incompleta. Se descarta la reconciliación y se replanifica.
	Conflict
	// Auth: 401/403, clave falsa u organización inactiva. Es configuración: el lote se conserva.
	Auth
)

// Error es una respuesta de error de la API (o un fallo de red si Status == 0).
type Error struct {
	Status     int
	Message    string
	RetryAfter time.Duration // de la cabecera Retry-After (429), si vino
	Err        error         // causa de red, si la hay
}

func (e *Error) Error() string {
	if e.Status == 0 {
		return "api: sin conexión: " + e.Message
	}
	return fmt.Sprintf("api: HTTP %d: %s", e.Status, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

// Class clasifica el error.
func (e *Error) Class() Class {
	switch {
	case e.Status == 0, e.Status >= 500, e.Status == http.StatusRequestTimeout, e.Status == http.StatusTooManyRequests:
		return Retry
	case e.Status == http.StatusConflict:
		return Conflict
	case e.Status == http.StatusUnauthorized, e.Status == http.StatusForbidden:
		return Auth
	default: // 400, 404, 413, 422...
		return Invalid
	}
}

// Classify devuelve la clase de cualquier error. Los que no son de la API
// (p. ej. un contexto cancelado) se tratan como reintentables.
func Classify(err error) Class {
	var ae *Error
	if errors.As(err, &ae) {
		return ae.Class()
	}
	return Retry
}

// Result es la respuesta 200 de POST /v1/sync/*.
type Result struct {
	BatchID     string `json:"batch_id"`
	Duplicate   bool   `json:"duplicate"`
	Received    int    `json:"received"`
	Inserted    *int   `json:"inserted"`
	Updated     *int   `json:"updated"`
	Unchanged   *int   `json:"unchanged"`
	Deactivated *int   `json:"deactivated"`
}

// Client habla con la API. La organización sale de la APIKey: nunca se manda org_id.
type Client struct {
	BaseURL      string // p. ej. https://api.midominio.com
	APIKey       string
	AgentVersion string
	HTTP         *http.Client
}

// New crea un cliente con un timeout razonable.
func New(baseURL, apiKey, agentVersion string) *Client {
	return &Client{
		BaseURL:      strings.TrimRight(baseURL, "/"),
		APIKey:       apiKey,
		AgentVersion: agentVersion,
		HTTP:         &http.Client{Timeout: 60 * time.Second},
	}
}

// SendBatch envía el cuerpo EXACTO de un lote. Reenviar el mismo cuerpo (mismo
// batch_id) es seguro: la API responde duplicate=true sin repetir el trabajo.
func (c *Client) SendBatch(ctx context.Context, kind string, body []byte) (*Result, error) {
	var path string
	switch kind {
	case store.KindProducts:
		path = "/v1/sync/products"
	case store.KindCustomers:
		path = "/v1/sync/customers"
	default:
		return nil, &Error{Status: http.StatusBadRequest, Message: "tipo de lote desconocido: " + kind}
	}
	raw, err := c.post(ctx, path, body)
	if err != nil {
		return nil, err
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		// 200 con cuerpo ilegible: la API pudo procesarlo; reenviar es seguro (idempotente).
		return nil, &Error{Status: 0, Message: "respuesta ilegible: " + err.Error(), Err: err}
	}
	return &res, nil
}

// Heartbeat avisa a la API que el agente está vivo. queueDepth y lastError son opcionales.
func (c *Client) Heartbeat(ctx context.Context, queueDepth int, lastError string) error {
	m := map[string]any{"agent_version": c.AgentVersion, "queue_depth": queueDepth}
	if lastError != "" {
		if len(lastError) > 500 {
			lastError = lastError[:500]
		}
		m["last_error"] = lastError
	}
	b, _ := json.Marshal(m)
	_, err := c.post(ctx, "/v1/agent/heartbeat", b)
	return err
}

func (c *Client) post(ctx context.Context, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, &Error{Status: http.StatusBadRequest, Message: err.Error(), Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("User-Agent", "erp-agent/"+c.AgentVersion)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, &Error{Status: 0, Message: err.Error(), Err: err}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, &Error{Status: 0, Message: "leyendo la respuesta: " + err.Error(), Err: err}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return raw, nil
	}
	return nil, &Error{
		Status:     resp.StatusCode,
		Message:    errorMessage(raw),
		RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
	}
}

// errorMessage extrae "message" del cuerpo de error de Nest (string o lista).
func errorMessage(raw []byte) string {
	var e struct {
		Message any `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil {
		switch m := e.Message.(type) {
		case string:
			return m
		case []any:
			parts := make([]string, 0, len(m))
			for _, p := range m {
				parts = append(parts, fmt.Sprint(p))
			}
			return strings.Join(parts, "; ")
		}
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// parseRetryAfter acepta segundos (lo que manda la API) o una fecha HTTP.
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
