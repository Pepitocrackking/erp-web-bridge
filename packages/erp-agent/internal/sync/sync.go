// Package sync es el ciclo de sincronización del agente: lee el ERP, decide
// entre delta y reconciliación completa, y deja los lotes resultantes en una
// cola (Sink) para que se envíen a la nube.
package sync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/batch"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/delta"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
)

// metaLastReconcile guarda, por tipo, cuándo se planificó la última reconciliación.
func metaLastReconcile(kind string) string { return "last_reconcile_" + kind }

// ErrEmptyInventory se devuelve cuando el ERP no entrega ningún registro pero
// ya se habían enviado antes: casi seguro es un fallo de lectura o un filtro
// mal puesto, y reconciliar así desactivaría todo el catálogo en la nube.
var ErrEmptyInventory = errors.New("el ERP devolvió 0 registros pero ya se habían sincronizado antes: no se reconcilia para no desactivar todo el catálogo")

// Sink recibe los lotes planificados. Los guarda de forma durable y en orden.
type Sink interface {
	Enqueue(ctx context.Context, entries []batch.Entry) error
}

// Syncer ejecuta los ciclos de sincronización.
type Syncer struct {
	ERP            erp.Adapter
	Store          *store.Store
	Sink           Sink
	Builder        *batch.Builder
	ReconcileEvery time.Duration // 0 = nunca reconcilia sola (solo con Force)
	Now            func() time.Time
	Log            *slog.Logger
}

// Result resume un ciclo.
type Result struct {
	ProductsChanged   int
	ProductsUnchanged int
	CustomersChanged  int
	ReconciledProd    bool
	ReconciledCust    bool
	Batches           int
}

func (s *Syncer) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Syncer) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.New(slog.DiscardHandler)
}

// due indica si toca reconciliar: nunca se hizo, o pasó el intervalo.
func (s *Syncer) due(ctx context.Context, kind string) (bool, error) {
	if s.ReconcileEvery <= 0 {
		return false, nil
	}
	v, err := s.Store.Meta(ctx, metaLastReconcile(kind))
	if err != nil {
		return false, err
	}
	if v == "" {
		return true, nil
	}
	last, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return true, nil // valor corrupto: reconcilia y se corrige solo
	}
	return !s.now().Before(last.Add(s.ReconcileEvery)), nil
}

// Cycle hace una pasada: productos y luego clientes. Si force es true,
// reconcilia ambos sin esperar al intervalo. Un error en productos no impide
// intentar clientes; se devuelven juntos.
func (s *Syncer) Cycle(ctx context.Context, force bool) (Result, error) {
	var res Result
	var errs []error
	if err := s.products(ctx, force, &res); err != nil {
		errs = append(errs, fmt.Errorf("productos: %w", err))
	}
	if err := s.customers(ctx, force, &res); err != nil {
		errs = append(errs, fmt.Errorf("clientes: %w", err))
	}
	return res, errors.Join(errs...)
}

func (s *Syncer) products(ctx context.Context, force bool, res *Result) error {
	current, err := s.ERP.Products(ctx)
	if err != nil {
		return err
	}
	known, err := s.Store.Fingerprints(ctx, store.KindProducts)
	if err != nil {
		return err
	}
	reconcile := force
	if !reconcile {
		if reconcile, err = s.due(ctx, store.KindProducts); err != nil {
			return err
		}
	}

	var entries []batch.Entry
	if reconcile {
		if len(current) == 0 && len(known) > 0 {
			return ErrEmptyInventory
		}
		if entries, err = s.Builder.ReconcileProducts(current); err != nil {
			return err
		}
		res.ReconciledProd = true
		res.ProductsChanged = len(current)
	} else {
		d := delta.DiffProducts(current, known)
		res.ProductsChanged, res.ProductsUnchanged = len(d.Changed), d.Unchanged
		if entries, err = s.Builder.ProductDelta(d); err != nil {
			return err
		}
	}
	return s.enqueue(ctx, store.KindProducts, entries, reconcile, res)
}

func (s *Syncer) customers(ctx context.Context, force bool, res *Result) error {
	current, err := s.ERP.Customers(ctx)
	if err != nil {
		return err
	}
	known, err := s.Store.Fingerprints(ctx, store.KindCustomers)
	if err != nil {
		return err
	}
	reconcile := force
	if !reconcile {
		if reconcile, err = s.due(ctx, store.KindCustomers); err != nil {
			return err
		}
	}

	var entries []batch.Entry
	if reconcile {
		if len(current) == 0 && len(known) > 0 {
			return ErrEmptyInventory
		}
		if entries, err = s.Builder.ReconcileCustomers(current); err != nil {
			return err
		}
		res.ReconciledCust = true
		res.CustomersChanged = len(current)
	} else {
		d := delta.DiffCustomers(current, known)
		res.CustomersChanged = len(d.Changed)
		if entries, err = s.Builder.CustomerDelta(d); err != nil {
			return err
		}
	}
	return s.enqueue(ctx, store.KindCustomers, entries, reconcile, res)
}

func (s *Syncer) enqueue(ctx context.Context, kind string, entries []batch.Entry, reconcile bool, res *Result) error {
	if len(entries) > 0 {
		if err := s.Sink.Enqueue(ctx, entries); err != nil {
			return fmt.Errorf("encolando: %w", err)
		}
		res.Batches += len(entries)
	}
	if reconcile {
		// Se anota al planificar (no al entregar): así, con la red caída, no se
		// replanifica una reconciliación nueva en cada ciclo.
		if err := s.Store.SetMeta(ctx, metaLastReconcile(kind), s.now().UTC().Format(time.RFC3339)); err != nil {
			return err
		}
	}
	s.log().Info("ciclo de sincronización", "tipo", kind, "reconciliacion", reconcile, "lotes", len(entries))
	return nil
}
