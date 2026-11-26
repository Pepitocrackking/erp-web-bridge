// Package orders lleva los pedidos web al ERP: pregunta a la API cuáles están pendientes y los
// deja en el ERP como BORRADOR, de uno en uno y en el orden en que llegaron.
package orders

import (
	"context"
	"log/slog"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/api"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// DefaultLimit es cuántos pedidos pendientes se piden por ciclo.
const DefaultLimit = 50

// Source es la nube: de dónde salen los pedidos pendientes (lo cumple *api.Client).
type Source interface {
	PendingOrders(ctx context.Context, limit int) ([]api.Order, error)
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
	Seen     int // pedidos pendientes que devolvió la API
	Created  int // borradores nuevos en el ERP
	Existing int // el ERP ya tenía el borrador (reintento): no se escribió nada
	Rejected int // el ERP no puede aceptarlos (cliente o SKU inexistente): no se reintentan solos
}

func (p *Processor) log() *slog.Logger {
	if p.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return p.Log
}

// Cycle procesa los pedidos pendientes. Un pedido rechazado por el ERP se anota y se sigue con el
// siguiente; cualquier otro error (red, ERP caído) corta el ciclo: lo no procesado sigue pendiente
// en la nube y se reintenta en el próximo ciclo, sin perder el orden.
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
			if erp.IsRejected(err) {
				res.Rejected++
				p.log().Warn("pedido rechazado por el ERP", "pedido", o.ID, "cliente", o.CustomerCode, "motivo", err.Error())
				continue
			}
			p.log().Error("no se pudo escribir el borrador; se reintenta en el próximo ciclo", "pedido", o.ID, "error", err.Error())
			return res, err
		}
		if got.Created {
			res.Created++
		} else {
			res.Existing++
		}
		p.log().Info("pedido llevado al ERP", "pedido", o.ID, "referencia", got.Reference, "nuevo", got.Created)
	}
	return res, nil
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
