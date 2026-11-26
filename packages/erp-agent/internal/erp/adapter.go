package erp

import "context"

// Tipos de ERP soportados. Coinciden con organizations.erp_type en la base.
const (
	TypeSaint = "saint"
	TypeMock  = "mock"
)

// Adapter es la interfaz común que implementa cada ERP. Es de solo lectura y
// devuelve siempre el conjunto COMPLETO: el delta lo calcula la capa de sync
// (hash contra SQLite), no el adaptador. Los pedidos hacia el ERP llegan en la
// Fase 7 y no forman parte de esta interfaz todavía.
//
// Contrato de los adaptadores:
//   - Devuelven importes en USD tal como los guarda el ERP; el redondeo a 2
//     decimales lo hace la capa de sync antes de calcular el hash.
//   - Los productos inactivos se devuelven con Active=false (no se omiten).
//   - Respetan ctx: si se cancela, abortan y devuelven su error.
//   - No devuelven SKU ni CustomerCode repetidos (la API responde 422).
type Adapter interface {
	// Type devuelve el tipo de ERP (TypeSaint, TypeMock...).
	Type() string
	// Products devuelve todos los productos del ERP.
	Products(ctx context.Context) ([]Product, error)
	// Customers devuelve todos los clientes del ERP.
	Customers(ctx context.Context) ([]Customer, error)
}
