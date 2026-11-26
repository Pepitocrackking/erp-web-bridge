package erp

import (
	"context"
	"errors"
)

// OrderLine es un renglón de un pedido web, con el precio unitario (USD) fijado por la API.
type OrderLine struct {
	SKU          string
	Quantity     int
	UnitPriceUSD float64
}

// OrderDraft es un pedido web listo para escribirse en el ERP como BORRADOR.
type OrderDraft struct {
	WebOrderID   string // id del pedido web (UUID): clave de idempotencia en el ERP
	CustomerCode string
	Lines        []OrderLine
	TotalUSD     float64
	ExchangeRate float64 // Bs por USD con la que se cotizó el pedido
	Notes        string
}

// DraftResult es lo que devuelve el ERP al guardar un borrador.
type DraftResult struct {
	Reference string // número del borrador en el ERP
	Created   bool   // false si el pedido ya estaba (reintento): no se escribió nada
}

// OrderWriter lo implementan los adaptadores que saben dejar pedidos en el ERP.
//
// Contrato:
//   - Solo escribe BORRADORES, nunca documentos fiscales.
//   - Es idempotente por WebOrderID: guardar dos veces el mismo pedido devuelve la misma
//     referencia (Created=false) y no crea un segundo borrador.
//   - Si el pedido no se puede aceptar de forma permanente (cliente o SKU inexistente o inactivo
//     en el ERP) devuelve un *RejectedError. Cualquier otro error es transitorio (ERP caído,
//     red...) y el pedido se reintenta más tarde.
type OrderWriter interface {
	CreateOrderDraft(ctx context.Context, o OrderDraft) (DraftResult, error)
}

// RejectedError dice que el ERP no puede aceptar el pedido y reintentar no lo arreglará.
type RejectedError struct{ Reason string }

func (e *RejectedError) Error() string { return "pedido rechazado por el ERP: " + e.Reason }

// IsRejected informa si err (o algo que envuelve) es un *RejectedError.
func IsRejected(err error) bool {
	var r *RejectedError
	return errors.As(err, &r)
}
