// Package orders lleva los pedidos web al ERP: pregunta a la API cuáles están pendientes, los deja
// en el ERP como BORRADOR (de uno en uno y en el orden en que llegaron) y le dice a la API qué
// pasó: confirmación con la referencia del ERP, o fallo permanente con su motivo.
package orders

import (
	"context"
	"errors"
	"log/slog"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// DefaultLimit es cuántos pedidos pendientes se piden por ciclo.
const DefaultLimit = 50

// Source es la nube (lo cumple *api.Client).
type Source interface {
	PendingOrders(ctx context.Context, limit int) ([]api.Order, error)
	ConfirmOrder(ctx context.Context, orderID, reference string) (*api.ConfirmResult, error)
	FailOrder(ctx context.Context, orderID, detail string) error
}

// Processor ejecuta un ciclo de pedidos.
type Processor struct {
	Source Source
	Writer erp.OrderWriter
	Limit  int // 0 = DefaultLimit
	Log    *slog.Logger
}

// Result resume un ciclo.
type Result struct {
	Seen      int // pedidos pendientes que devolvió la API
	Created   int // borradores nuevos en el ERP
	Existing  int // el ERP ya tenía el borrador (reintento): no se escribió nada
	Confirmed int // pedidos que la API ya tiene como synced_to_erp
	Rejected  int // el ERP no puede aceptarlos (cliente o SKU inexistente): se informan como error
}

func (p *Processor) log() *slog.Logger {
	if p.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return p.Log
}

// Cycle procesa los pedidos pendientes.
//
// Reintentos: todo lo que falla por causas transitorias (red, API o ERP caídos, clave rechazada)
// corta el ciclo y deja el pedido como estaba; el próximo ciclo lo vuelve a ver pendiente y lo
// completa sin duplicar nada (el ERP devuelve el borrador existente y la API confirma
// idempotentemente). Así el orden de llegada se conserva.
//
// Fallos permanentes: si el ERP rechaza el pedido se informa a la API (queda en "error" con el
// motivo, a la vista del personal, que puede reintentarlo desde el panel) y se sigue con el
// siguiente. Si esa notificación falla por red, el pedido sigue pendiente y se repite el rechazo
// en el próximo ciclo.
func (p *Processor) Cycle(ctx context.Context) (Result, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	orders, err := p.Source.PendingOrders(ctx, limit)
	if err != nil {
		return Result{}, err
	}
	res := Result{Seen: len(orders)}
	for _, o := range orders {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		got, err := p.Writer.CreateOrderDraft(ctx, toDraft(o))
		if err != nil {
			if !erp.IsRejected(err) {
				p.log().Error("no se pudo escribir el borrador; se reintenta en el próximo ciclo", "pedido", o.ID, "error", err.Error())
				return res, err
			}
			var rej *erp.RejectedError
			errors.As(err, &rej) // IsRejected garantiza que existe
			res.Rejected++
			p.log().Warn("pedido rechazado por el ERP", "pedido", o.ID, "cliente", o.CustomerCode, "motivo", rej.Reason)
			if _, rerr := p.report(ctx, o, "no se pudo informar el rechazo", func() error {
				return p.Source.FailOrder(ctx, o.ID, rej.Reason)
			}); rerr != nil {
				return res, rerr
			}
			continue
		}
		if got.Created {
			res.Created++
		} else {
			res.Existing++
		}
		done, err := p.report(ctx, o, "no se pudo confirmar el borrador", func() error {
			_, err := p.Source.ConfirmOrder(ctx, o.ID, got.Reference)
			return err
		})
		if err != nil {
			return res, err
		}
		if done {
			res.Confirmed++
			p.log().Info("pedido llevado al ERP", "pedido", o.ID, "referencia", got.Reference, "borrador_nuevo", got.Created)
		}
	}
	return res, nil
}

// report manda a la API el resultado de un pedido. Devuelve done=true si la API lo aceptó. Devuelve
// error solo si conviene cortar el ciclo (fallo transitorio o de autenticación). Un 409 o un 4xx
// significan que la API ya no considera pendiente ese pedido (p. ej. lo anularon mientras tanto):
// se anota y se sigue.
func (p *Processor) report(_ context.Context, o api.Order, what string, call func() error) (done bool, err error) {
	if err := call(); err != nil {
		switch api.Classify(err) {
		case api.Retry, api.Auth:
			p.log().Error(what+"; se reintenta en el próximo ciclo", "pedido", o.ID, "error", err.Error())
			return false, err
		default:
			p.log().Warn(what+": la API ya no lo considera pendiente", "pedido", o.ID, "error", err.Error())
			return false, nil
		}
	}
	return true, nil
}

func toDraft(o api.Order) erp.OrderDraft {
	d := erp.OrderDraft{
		WebOrderID:   o.ID,
		CustomerCode: o.CustomerCode,
		TotalUSD:     o.TotalUSD,
		ExchangeRate: o.ExchangeRateUsed,
	}
	if o.Notes != nil {
		d.Notes = *o.Notes
	}
	for _, it := range o.Items {
		d.Lines = append(d.Lines, erp.OrderLine{SKU: it.SKU, Quantity: it.Quantity, UnitPriceUSD: it.UnitPriceUSD})
	}
	return d
}
