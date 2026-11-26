// Package sender vacía la cola local hacia la API: de uno en uno y en orden,
// con reintentos con backoff, sin perder nada si cae la red o la luz.
//
// Garantías:
//   - Un lote solo sale de la cola cuando la API respondió 200. Si el agente
//     muere después de enviarlo pero antes de anotarlo, el reenvío (mismo
//     cuerpo, mismo batch_id) vuelve como duplicate=true y se da por entregado.
//   - Las huellas del lote se guardan y el lote sale de la cola en una sola
//     transacción SQLite.
//   - Un lote que la API rechaza de forma definitiva (400/413/422) o una
//     reconciliación incompleta (409) se descartan; no bloquean los demás.
package sender

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
)

// Poster es lo que el sender necesita del cliente HTTP (lo cumple *api.Client).
type Poster interface {
	SendBatch(ctx context.Context, kind string, body []byte) (*api.Result, error)
}

// RetryError indica que hay que reintentar más tarde. After > 0 es lo que pidió la API (429).
type RetryError struct {
	After time.Duration
	Err   error
}

func (e *RetryError) Error() string { return "reintentar: " + e.Err.Error() }
func (e *RetryError) Unwrap() error { return e.Err }

// ErrAuth: la API rechazó la clave. Es de configuración; el lote se conserva.
var ErrAuth = errors.New("la API rechazó la x-api-key (clave falsa u organización inactiva)")

// Sender vacía la cola.
type Sender struct {
	Store  *store.Store
	Client Poster
	Log    *slog.Logger

	BackoffBase   time.Duration // por defecto 1 s
	BackoffMax    time.Duration // por defecto 5 min
	MaxRetryAfter time.Duration // tope a lo que pida la API; por defecto 10 min
	Sleep         func(ctx context.Context, d time.Duration) error
	Jitter        func() float64 // en [0,1); por defecto aleatorio

	mu      sync.Mutex
	lastErr string
}

// DrainResult resume una pasada.
type DrainResult struct {
	Sent       int // lotes entregados (incluye duplicados)
	Duplicates int // de ellos, los que la API ya tenía
	Discarded  int // lotes descartados por rechazo definitivo
}

func (s *Sender) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.New(slog.DiscardHandler)
}

// LastError devuelve el último error relevante ("" si el último intento fue bien). Lo usa el heartbeat.
func (s *Sender) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

func (s *Sender) setErr(msg string) {
	s.mu.Lock()
	s.lastErr = msg
	s.mu.Unlock()
}

// Drain envía lotes hasta vaciar la cola o hasta el primer error reintentable.
// Con un error reintentable devuelve *RetryError (el lote queda en la cola).
func (s *Sender) Drain(ctx context.Context) (DrainResult, error) {
	var res DrainResult
	for {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		e, err := s.Store.Next(ctx)
		if err != nil {
			return res, err
		}
		if e == nil {
			if res.Discarded == 0 { // si se descartó algo, el rechazo queda como último error para el heartbeat
				s.setErr("")
			}
			return res, nil
		}

		r, err := s.Client.SendBatch(ctx, e.Kind, e.Body)
		if err == nil {
			// Si esto falla (disco), el lote sigue en la cola y se reenvía: será un duplicado inofensivo.
			if cerr := s.Store.Complete(ctx, *e); cerr != nil {
				return res, &RetryError{Err: fmt.Errorf("guardando la entrega: %w", cerr)}
			}
			res.Sent++
			if r.Duplicate {
				res.Duplicates++
			}
			s.log().Info("lote entregado", "batch_id", e.BatchID, "tipo", e.Kind, "registros", e.Records, "duplicado", r.Duplicate)
			continue
		}
		if ctx.Err() != nil {
			return res, ctx.Err() // apagado: no es un fallo del lote
		}

		var ae *api.Error
		errors.As(err, &ae)
		switch api.Classify(err) {
		case api.Retry:
			_ = s.Store.Fail(ctx, e.BatchID, err.Error())
			s.setErr(err.Error())
			re := &RetryError{Err: err}
			if ae != nil {
				re.After = ae.RetryAfter
			}
			s.log().Warn("envío fallido, se reintentará", "batch_id", e.BatchID, "error", err.Error(), "intentos", e.Attempts+1)
			return res, re
		case api.Auth:
			_ = s.Store.Fail(ctx, e.BatchID, err.Error())
			s.setErr(err.Error())
			s.log().Error("la API rechazó la clave", "error", err.Error())
			return res, fmt.Errorf("%w: %v", ErrAuth, err)
		default: // Invalid y Conflict: el lote no tiene arreglo reenviándolo igual
			n, derr := s.Store.Discard(ctx, *e)
			if derr != nil {
				return res, derr
			}
			res.Discarded += n
			s.setErr(err.Error())
			s.log().Error("lote rechazado por la API y descartado", "batch_id", e.BatchID, "tipo", e.Kind,
				"reconciliacion", e.ReconciliationID, "descartados", n, "error", err.Error())
		}
	}
}

// Backoff calcula la espera tras el intento número attempt (0, 1, 2...):
// base·2^attempt con tope en max y ±20 % de jitter para no sincronizar muchos agentes.
func Backoff(attempt int, base, max time.Duration, jitter float64) time.Duration {
	d := float64(base) * math.Pow(2, float64(attempt))
	if d > float64(max) || math.IsInf(d, 0) {
		d = float64(max)
	}
	return time.Duration(d * (0.8 + 0.4*jitter))
}

func (s *Sender) cfg() (base, max, maxRA time.Duration) {
	base, max, maxRA = s.BackoffBase, s.BackoffMax, s.MaxRetryAfter
	if base <= 0 {
		base = time.Second
	}
	if max <= 0 {
		max = 5 * time.Minute
	}
	if maxRA <= 0 {
		maxRA = 10 * time.Minute
	}
	return
}

func (s *Sender) sleep(ctx context.Context, d time.Duration) error {
	if s.Sleep != nil {
		return s.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// delay decide cuánto esperar tras un error reintentable.
func (s *Sender) delay(attempt int, err error) time.Duration {
	base, max, maxRA := s.cfg()
	var re *RetryError
	if errors.As(err, &re) && re.After > 0 {
		return min(re.After, maxRA)
	}
	if errors.Is(err, ErrAuth) {
		return max // sin sentido insistir deprisa con una clave mala
	}
	j := rand.Float64()
	if s.Jitter != nil {
		j = s.Jitter()
	}
	return Backoff(attempt, base, max, j)
}

// Run vacía la cola cada vez que se le avisa por kick (y al arrancar, por si
// quedaron lotes de antes de un reinicio). Ante un error espera con backoff y
// reintenta sola. Termina cuando se cancela ctx.
func (s *Sender) Run(ctx context.Context, kick <-chan struct{}) error {
	attempt := 0
	for {
		_, err := s.Drain(ctx)
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case err == nil:
			attempt = 0
			select {
			case <-kick:
			case <-ctx.Done():
				return ctx.Err()
			}
		default:
			// Reintentable, clave rechazada o error inesperado (p. ej. disco): en
			// todos los casos se espera con backoff y se reintenta, sin girar en caliente.
			d := s.delay(attempt, err)
			attempt++
			s.log().Info("esperando para reintentar", "espera", d.String(), "intento", attempt)
			if serr := s.sleep(ctx, d); serr != nil {
				return serr
			}
		}
	}
}
