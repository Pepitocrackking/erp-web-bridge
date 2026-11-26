// Package agent une las piezas: ERP, ciclo de sync, cola, sender y heartbeat.
package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/microsoft/go-mssqldb" // driver "sqlserver"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/batch"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/config"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp/mock"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp/saint"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/orders"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/sender"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
	agentsync "github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/sync"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/version"
)

// NewLogger crea el logger estructurado (stderr, JSON por defecto).
func NewLogger(w io.Writer, c config.Log) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(strings.ToLower(c.Level))); err != nil {
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	var h slog.Handler
	if strings.EqualFold(c.Format, "text") {
		h = slog.NewTextHandler(w, opts)
	} else {
		h = slog.NewJSONHandler(w, opts)
	}
	return slog.New(h).With("agent_version", version.Version)
}

// NewERP crea el adaptador según la configuración. El cierre libera la conexión.
func NewERP(cfg *config.Config, log *slog.Logger) (erp.Adapter, func() error, error) {
	switch cfg.ERP.Type {
	case erp.TypeMock:
		return mock.New(mock.Config{Products: cfg.ERP.Mock.Products, Customers: cfg.ERP.Mock.Customers, Seed: cfg.ERP.Mock.Seed}),
			func() error { return nil }, nil
	case erp.TypeSaint:
		m, err := saint.LoadMapping(cfg.ERP.Saint.MappingFile)
		if err != nil {
			return nil, nil, err
		}
		db, err := sql.Open("sqlserver", cfg.ERP.Saint.DSN)
		if err != nil {
			return nil, nil, fmt.Errorf("saint: abriendo la conexión: %w", err)
		}
		db.SetMaxOpenConns(2)
		db.SetConnMaxLifetime(30 * time.Minute)
		return saint.New(db, m, log), db.Close, nil
	}
	return nil, nil, fmt.Errorf("erp.type desconocido: %q", cfg.ERP.Type)
}

// Options son los modos de ejecución que no vienen del archivo.
type Options struct {
	Once      bool // un ciclo, vaciar la cola y salir (útil para pruebas y tareas programadas)
	Reconcile bool // forzar una reconciliación completa en el primer ciclo
}

// App es el agente armado.
type App struct {
	cfg    *config.Config
	log    *slog.Logger
	erp    erp.Adapter
	store  *store.Store
	client *api.Client
	sender *sender.Sender
	syncer *agentsync.Syncer
	orders *orders.Processor // nil si el ERP no sabe escribir pedidos o está desactivado

	isolationOK bool // el login del ERP ya se verificó: no puede escribir fuera de los borradores

	lastSyncErr atomic.Value // string
}

// New arma el agente (abre la base local y el ERP). Close libera todo.
func New(ctx context.Context, cfg *config.Config, log *slog.Logger, closers *[]func() error) (*App, error) {
	adapter, closeERP, err := NewERP(cfg, log)
	if err != nil {
		return nil, err
	}
	*closers = append(*closers, closeERP)
	st, err := store.Open(ctx, cfg.Store.Path)
	if err != nil {
		return nil, err
	}
	*closers = append(*closers, st.Close)

	client := api.New(cfg.API.URL, cfg.API.APIKey, version.Version)
	a := &App{cfg: cfg, log: log, erp: adapter, store: st, client: client}
	a.sender = &sender.Sender{Store: st, Client: client, Log: log}
	a.syncer = &agentsync.Syncer{
		ERP: adapter, Store: st, Sink: st, Builder: batch.NewBuilder(),
		ReconcileEvery: cfg.Sync.ReconcileInterval, Log: log,
	}
	if w, ok := adapter.(erp.OrderWriter); ok && cfg.Orders.Enabled {
		a.orders = &orders.Processor{Source: client, Writer: w, Limit: cfg.Orders.Limit, Log: log}
	}
	a.lastSyncErr.Store("")
	return a, nil
}

// Run ejecuta el agente hasta que se cancele ctx (o, con Once, hasta vaciar la cola).
func Run(ctx context.Context, cfg *config.Config, log *slog.Logger, opts Options) error {
	var closers []func() error
	defer func() {
		for i := len(closers) - 1; i >= 0; i-- {
			if err := closers[i](); err != nil {
				log.Warn("error al cerrar", "error", err.Error())
			}
		}
	}()
	a, err := New(ctx, cfg, log, &closers)
	if err != nil {
		return err
	}
	log.Info("agente iniciado", "erp", a.erp.Type(), "api", cfg.API.URL,
		"sync_interval", cfg.Sync.Interval.String(), "reconcile_interval", cfg.Sync.ReconcileInterval.String(),
		"store", cfg.Store.Path)
	if opts.Once {
		return a.once(ctx, opts.Reconcile)
	}
	return a.loop(ctx, opts.Reconcile)
}

func (a *App) setSyncErr(err error) {
	if err == nil {
		a.lastSyncErr.Store("")
		return
	}
	a.lastSyncErr.Store(err.Error())
}

// cycle hace una pasada de sincronización y avisa al sender si encoló algo.
func (a *App) cycle(ctx context.Context, force bool, kick chan<- struct{}) {
	res, err := a.syncer.Cycle(ctx, force)
	if err != nil {
		a.log.Error("ciclo de sincronización con errores", "error", err.Error())
	}
	oerr := a.ordersCycle(ctx)
	a.setSyncErr(errors.Join(err, oerr))
	depth, _ := a.store.Depth(ctx)
	a.log.Info("ciclo terminado", "productos_cambiados", res.ProductsChanged, "productos_sin_cambios", res.ProductsUnchanged,
		"clientes_cambiados", res.CustomersChanged, "lotes_encolados", res.Batches, "cola_pendiente", depth)
	if res.Batches > 0 && kick != nil {
		select {
		case kick <- struct{}{}:
		default: // ya hay un aviso pendiente
		}
	}
}

// ordersCycle lleva los pedidos pendientes de la web al ERP como borradores.
func (a *App) ordersCycle(ctx context.Context) error {
	if a.orders == nil {
		return nil
	}
	if err := a.ensureWriteIsolation(ctx); err != nil {
		return err
	}
	res, err := a.orders.Cycle(ctx)
	if err != nil {
		a.log.Error("ciclo de pedidos con errores", "error", err.Error())
	}
	if res.Seen > 0 {
		a.log.Info("ciclo de pedidos", "pendientes", res.Seen, "borradores_creados", res.Created,
			"ya_existian", res.Existing, "rechazados", res.Rejected)
	}
	return err
}

// ensureWriteIsolation verifica, contra el propio ERP, que el login del agente solo puede escribir
// borradores (segunda capa del cero riesgo contable). Mientras no pase, NO se escribe ningún pedido;
// se repite en cada ciclo hasta que pase (así corregir el login no exige reiniciar). El error llega
// al heartbeat y por tanto al panel.
func (a *App) ensureWriteIsolation(ctx context.Context) error {
	if a.isolationOK {
		return nil
	}
	chk, ok := a.erp.(erp.WriteIsolationChecker)
	if !ok {
		a.isolationOK = true
		return nil
	}
	if err := chk.VerifyWriteIsolation(ctx); err != nil {
		if erp.IsUnsafeLogin(err) {
			a.log.Error("pedidos detenidos: el login del ERP puede escribir fuera de los borradores", "error", err.Error())
		} else {
			a.log.Warn("no se pudo verificar el login del ERP; se reintenta en el próximo ciclo", "error", err.Error())
		}
		return err
	}
	a.isolationOK = true
	a.log.Info("login del ERP verificado: solo puede escribir borradores")
	return nil
}

// once: un ciclo y vaciar la cola. Falla si la cola no queda vacía.
func (a *App) once(ctx context.Context, force bool) error {
	a.cycle(ctx, force, nil)
	res, err := a.sender.Drain(ctx)
	a.log.Info("cola vaciada", "entregados", res.Sent, "duplicados", res.Duplicates, "descartados", res.Discarded)
	if err != nil {
		return err
	}
	if msg := a.lastSyncErr.Load().(string); msg != "" {
		return errors.New(msg)
	}
	return nil
}

func (a *App) loop(ctx context.Context, force bool) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	kick := make(chan struct{}, 1)
	var wg sync.WaitGroup

	wg.Add(1)
	go func() { // sender: vacía la cola al arrancar y con cada aviso
		defer wg.Done()
		if err := a.sender.Run(ctx, kick); err != nil && !errors.Is(err, context.Canceled) {
			a.log.Error("el sender terminó", "error", err.Error())
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		a.heartbeatLoop(ctx)
	}()

	t := time.NewTicker(a.cfg.Sync.Interval)
	defer t.Stop()
	a.cycle(ctx, force, kick)
	for {
		select {
		case <-ctx.Done():
			a.log.Info("apagando el agente")
			wg.Wait()
			return nil
		case <-t.C:
			a.cycle(ctx, false, kick)
		}
	}
}

// heartbeatLoop avisa que el agente vive. last_error se informa solo cuando
// cambia o cada 15 min, para no llenar sync_logs si un error persiste.
func (a *App) heartbeatLoop(ctx context.Context) {
	var lastSent string
	var lastSentAt time.Time
	beat := func() {
		depth, err := a.store.Depth(ctx)
		if err != nil {
			a.log.Warn("heartbeat: no se pudo leer la cola", "error", err.Error())
		}
		msg := a.sender.LastError()
		if msg == "" {
			msg, _ = a.lastSyncErr.Load().(string)
		}
		report := ""
		if msg != "" && (msg != lastSent || time.Since(lastSentAt) > 15*time.Minute) {
			report = msg
		}
		hctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if err := a.client.Heartbeat(hctx, depth, report); err != nil {
			a.log.Warn("heartbeat fallido", "error", err.Error())
			return
		}
		if report != "" {
			lastSent, lastSentAt = report, time.Now()
		} else if msg == "" {
			lastSent = ""
		}
		a.log.Debug("heartbeat enviado", "cola", depth)
	}
	beat()
	t := time.NewTicker(a.cfg.Heartbeat.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			beat()
		}
	}
}
