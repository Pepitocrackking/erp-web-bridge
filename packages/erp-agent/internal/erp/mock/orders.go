package mock

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

var _ erp.OrderWriter = (*Adapter)(nil)

// Draft es un borrador guardado en el ERP simulado.
type Draft struct {
	Reference string
	Order     erp.OrderDraft
}

// CreateOrderDraft implementa erp.OrderWriter: guarda el pedido en memoria con las mismas reglas
// que el adaptador de Saint (idempotente por id web; cliente y SKU deben existir y estar activos).
func (a *Adapter) CreateOrderDraft(ctx context.Context, o erp.OrderDraft) (erp.DraftResult, error) {
	if err := ctx.Err(); err != nil {
		return erp.DraftResult{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if d, ok := a.drafts[o.WebOrderID]; ok {
		return erp.DraftResult{Reference: d.Reference, Created: false}, nil
	}
	if len(o.Lines) == 0 {
		return erp.DraftResult{}, &erp.RejectedError{Reason: "pedido sin renglones"}
	}
	if c, ok := a.customers[o.CustomerCode]; !ok {
		return erp.DraftResult{}, &erp.RejectedError{Reason: fmt.Sprintf("el cliente %q no existe en el ERP", o.CustomerCode)}
	} else if !c.Active {
		return erp.DraftResult{}, &erp.RejectedError{Reason: fmt.Sprintf("el cliente %q está inactivo en el ERP", o.CustomerCode)}
	}
	var bad []string
	for _, l := range o.Lines {
		if p, ok := a.products[l.SKU]; !ok || !p.Active {
			bad = append(bad, l.SKU)
		}
	}
	if len(bad) > 0 {
		sort.Strings(bad)
		return erp.DraftResult{}, &erp.RejectedError{Reason: "productos inexistentes o inactivos en el ERP: " + strings.Join(bad, ", ")}
	}
	if a.drafts == nil {
		a.drafts = map[string]Draft{}
	}
	ref := fmt.Sprintf("MK%07d", len(a.drafts)+1)
	a.drafts[o.WebOrderID] = Draft{Reference: ref, Order: o}
	return erp.DraftResult{Reference: ref, Created: true}, nil
}

// Drafts devuelve los borradores guardados, ordenados por referencia.
func (a *Adapter) Drafts() []Draft {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Draft, 0, len(a.drafts))
	for _, d := range a.drafts {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Reference < out[j].Reference })
	return out
}
