// Package batch construye los lotes de sincronización con la forma exacta que
// exige la API (contrato SyncBatch de shared-types): delta normal y
// reconciliación completa repartida en varios lotes.
package batch

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/delta"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/store"
)

// MaxRecords es el máximo de registros por lote que acepta la API.
const MaxRecords = 1000

// Entry es un lote listo para enviar. Body es el JSON EXACTO del cuerpo: al
// reenviar tras un corte se manda el mismo cuerpo y el mismo batch_id, así la
// API lo reconoce como duplicado y no repite el trabajo.
type Entry struct {
	BatchID          string       `json:"batch_id"`
	Kind             string       `json:"kind"` // store.KindProducts | store.KindCustomers
	ReconciliationID string       `json:"reconciliation_id,omitempty"`
	Final            bool         `json:"final"`
	Records          int          `json:"records"`
	Body             []byte       `json:"body"`
	Commit           store.Commit `json:"commit"` // huellas a guardar cuando la nube confirme
}

// Builder construye lotes. Now y NewID se pueden sustituir en las pruebas.
type Builder struct {
	MaxRecords int
	Now        func() time.Time
	NewID      func() string
}

// NewBuilder devuelve un Builder con valores de producción.
func NewBuilder() *Builder {
	return &Builder{MaxRecords: MaxRecords, Now: time.Now, NewID: NewUUID}
}

// NewUUID genera un UUID v4.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("sin entropía del sistema: %v", err)) // no hay forma sensata de seguir
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

type body struct {
	BatchID            string  `json:"batch_id"`
	SentAt             string  `json:"sent_at"`
	Kind               string  `json:"kind"`
	FullReconciliation bool    `json:"full_reconciliation"`
	ReconciliationID   *string `json:"reconciliation_id,omitempty"`
	FinalBatch         *bool   `json:"final_batch,omitempty"`
	TotalRecords       *int    `json:"total_records,omitempty"`
	Records            any     `json:"records"`
}

func (b *Builder) max() int {
	if b.MaxRecords <= 0 || b.MaxRecords > MaxRecords {
		return MaxRecords
	}
	return b.MaxRecords
}

func (b *Builder) sentAt() string { return b.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// chunks reparte n elementos en tramos de a lo sumo size; con n=0 devuelve un
// tramo vacío (la reconciliación de un ERP vacío sigue necesitando su lote final).
func chunks(n, size int) [][2]int {
	if n == 0 {
		return [][2]int{{0, 0}}
	}
	var out [][2]int
	for i := 0; i < n; i += size {
		out = append(out, [2]int{i, min(i+size, n)})
	}
	return out
}

// ProductDelta arma los lotes normales de los productos que cambiaron. Cada
// lote guarda solo las huellas de sus propios registros.
func (b *Builder) ProductDelta(d delta.ProductDiff) ([]Entry, error) {
	if len(d.Changed) == 0 {
		return nil, nil
	}
	var out []Entry
	for _, c := range chunks(len(d.Changed), b.max()) {
		recs := d.Changed[c[0]:c[1]]
		fps := make(map[string]string, len(recs))
		for _, r := range recs {
			fps[r.SKU] = d.Fingerprints[r.SKU]
		}
		e, err := b.entry(store.KindProducts, recs, "", false, 0, store.Commit{Fingerprints: fps})
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// CustomerDelta arma los lotes normales de los clientes que cambiaron.
func (b *Builder) CustomerDelta(d delta.CustomerDiff) ([]Entry, error) {
	if len(d.Changed) == 0 {
		return nil, nil
	}
	var out []Entry
	for _, c := range chunks(len(d.Changed), b.max()) {
		recs := d.Changed[c[0]:c[1]]
		fps := make(map[string]string, len(recs))
		for _, r := range recs {
			fps[r.CustomerCode] = d.Fingerprints[r.CustomerCode]
		}
		e, err := b.entry(store.KindCustomers, recs, "", false, 0, store.Commit{Fingerprints: fps})
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// ReconcileProducts arma la reconciliación completa: TODOS los productos en
// uno o más lotes con el mismo reconciliation_id. Solo el último lleva
// final_batch=true y total_records; solo él guarda las huellas (Replace con el
// inventario entero), de modo que lo que ya no está en el ERP desaparece
// también del almacén local.
func (b *Builder) ReconcileProducts(products []erp.Product) ([]Entry, error) {
	recs := make([]erp.ProductRecord, len(products))
	fps := make(map[string]string, len(products))
	for i, p := range products {
		n := delta.NormalizeProduct(p)
		recs[i] = erp.ProductRecord{Product: n, SyncHash: delta.SyncHash(n)}
		fps[n.SKU] = delta.ProductFingerprint(n)
	}
	if len(fps) != len(recs) {
		return nil, fmt.Errorf("batch: hay SKU repetidos en el inventario")
	}
	return b.reconcile(store.KindProducts, len(recs), fps, func(from, to int) any { return recs[from:to] })
}

// ReconcileCustomers es la reconciliación completa de clientes.
func (b *Builder) ReconcileCustomers(customers []erp.Customer) ([]Entry, error) {
	recs := make([]erp.Customer, len(customers))
	fps := make(map[string]string, len(customers))
	for i, c := range customers {
		n := delta.NormalizeCustomer(c)
		recs[i] = n
		fps[n.CustomerCode] = delta.CustomerFingerprint(n)
	}
	if len(fps) != len(recs) {
		return nil, fmt.Errorf("batch: hay códigos de cliente repetidos")
	}
	return b.reconcile(store.KindCustomers, len(recs), fps, func(from, to int) any { return recs[from:to] })
}

func (b *Builder) reconcile(kind string, total int, all map[string]string, slice func(from, to int) any) ([]Entry, error) {
	recID := b.NewID()
	cs := chunks(total, b.max())
	out := make([]Entry, 0, len(cs))
	for i, c := range cs {
		final := i == len(cs)-1
		var commit store.Commit
		if final {
			commit = store.Commit{Replace: true, Fingerprints: all}
		}
		e, err := b.entry(kind, slice(c[0], c[1]), recID, final, total, commit)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// entry serializa un lote. recID == "" es un lote normal.
func (b *Builder) entry(kind string, records any, recID string, final bool, total int, commit store.Commit) (Entry, error) {
	e := Entry{BatchID: b.NewID(), Kind: kind, ReconciliationID: recID, Final: final, Commit: commit}
	bd := body{BatchID: e.BatchID, SentAt: b.sentAt(), Kind: kind, Records: records}
	if recID != "" {
		bd.FullReconciliation = true
		bd.ReconciliationID = &recID
		bd.FinalBatch = &final
		if final {
			bd.TotalRecords = &total
		}
	}
	raw, err := json.Marshal(bd)
	if err != nil {
		return Entry{}, fmt.Errorf("batch: serializando: %w", err)
	}
	e.Body = raw
	switch r := records.(type) {
	case []erp.ProductRecord:
		e.Records = len(r)
	case []erp.Customer:
		e.Records = len(r)
	}
	return e, nil
}
