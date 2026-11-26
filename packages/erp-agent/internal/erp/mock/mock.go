// Package mock implementa un erp.Adapter en memoria con datos deterministas,
// para demos sin ERP físico y para las pruebas de las capas de sync y cola.
//
// Los mismos parámetros (Config) producen siempre los mismos datos, y las
// mutaciones son operaciones explícitas, así que las pruebas son repetibles.
package mock

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
	"sync"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// Config controla el volumen de datos generados.
type Config struct {
	Products  int   // cantidad de productos (por defecto 50)
	Customers int   // cantidad de clientes (por defecto 10)
	Seed      int64 // semilla del generador (por defecto 1)
}

// Adapter es un ERP simulado en memoria. Es seguro para uso concurrente.
type Adapter struct {
	mu        sync.Mutex
	products  map[string]erp.Product
	customers map[string]erp.Customer
	step      int
	drafts    map[string]Draft // pedidos web guardados, por id del pedido
}

var _ erp.Adapter = (*Adapter)(nil)

var categories = []string{"VIVERES", "BEBIDAS", "LACTEOS", "LIMPIEZA", "CUIDADO", "SNACKS"}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// New genera el ERP simulado. Los SKU son P00001... y los clientes C00001...,
// como en el sandbox de Saint.
func New(cfg Config) *Adapter {
	if cfg.Products <= 0 {
		cfg.Products = 50
	}
	if cfg.Customers <= 0 {
		cfg.Customers = 10
	}
	if cfg.Seed == 0 {
		cfg.Seed = 1
	}
	r := rand.New(rand.NewPCG(uint64(cfg.Seed), 0x9e3779b97f4a7c15))

	a := &Adapter{
		products:  make(map[string]erp.Product, cfg.Products),
		customers: make(map[string]erp.Customer, cfg.Customers),
	}
	for i := 1; i <= cfg.Products; i++ {
		cat := categories[r.IntN(len(categories))]
		a.products[sku(i)] = erp.Product{
			SKU:      sku(i),
			Name:     fmt.Sprintf("PRODUCTO %s %05d", cat, i),
			Category: &cat,
			PriceUSD: round2(0.5 + r.Float64()*49.5),
			Stock:    float64(r.IntN(500)),
			Active:   r.IntN(20) != 0, // ~5 % inactivos
		}
	}
	for i := 1; i <= cfg.Customers; i++ {
		limit := float64(500 * (1 + r.IntN(20)))
		a.customers[code(i)] = erp.Customer{
			CustomerCode:   code(i),
			TaxID:          fmt.Sprintf("J-%08d-%d", 30000000+i, i%10),
			BusinessName:   fmt.Sprintf("COMERCIAL MOCK %03d C.A.", i),
			CreditLimitUSD: limit,
			CurrentDebtUSD: round2(limit * r.Float64() * 1.1), // algunos superan el límite
			Active:         r.IntN(20) != 0,
		}
	}
	return a
}

func sku(i int) string  { return fmt.Sprintf("P%05d", i) }
func code(i int) string { return fmt.Sprintf("C%05d", i) }

// Type implementa erp.Adapter.
func (a *Adapter) Type() string { return erp.TypeMock }

// Products implementa erp.Adapter: devuelve todos los productos ordenados por SKU.
func (a *Adapter) Products(ctx context.Context) ([]erp.Product, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]erp.Product, 0, len(a.products))
	for _, p := range a.products {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SKU < out[j].SKU })
	return out, nil
}

// Customers implementa erp.Adapter: devuelve todos los clientes ordenados por código.
func (a *Adapter) Customers(ctx context.Context) ([]erp.Customer, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]erp.Customer, 0, len(a.customers))
	for _, c := range a.customers {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CustomerCode < out[j].CustomerCode })
	return out, nil
}

// ---- Mutaciones deterministas (las usan las pruebas y el simulador de ERP) ----

func (a *Adapter) update(s string, f func(*erp.Product)) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.products[s]
	if !ok {
		return fmt.Errorf("mock: el producto %q no existe", s)
	}
	f(&p)
	a.products[s] = p
	return nil
}

// SetPrice cambia el precio de un producto.
func (a *Adapter) SetPrice(s string, priceUSD float64) error {
	return a.update(s, func(p *erp.Product) { p.PriceUSD = round2(priceUSD) })
}

// SetStock cambia la existencia de un producto.
func (a *Adapter) SetStock(s string, stock float64) error {
	return a.update(s, func(p *erp.Product) { p.Stock = round2(stock) })
}

// SetActive activa o desactiva un producto (sigue apareciendo en Products).
func (a *Adapter) SetActive(s string, active bool) error {
	return a.update(s, func(p *erp.Product) { p.Active = active })
}

// Remove elimina un producto del ERP: deja de aparecer en Products.
func (a *Adapter) Remove(s string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.products[s]; !ok {
		return fmt.Errorf("mock: el producto %q no existe", s)
	}
	delete(a.products, s)
	return nil
}

// Add agrega (o reemplaza) un producto.
func (a *Adapter) Add(p erp.Product) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.products[p.SKU] = p
}

// Mutate aplica un paso fijo de cambios y devuelve los SKU tocados, en orden.
// El paso k (1, 2, 3...) sube un 10 % el precio de 3 productos consecutivos y
// resta 1 unidad de stock (mínimo 0) a otros 2, empezando por el SKU
// P(3(k-1)+1). Si no hay suficientes productos, da la vuelta sobre los
// existentes. Dos adaptadores con la misma Config y los mismos pasos quedan
// idénticos.
func (a *Adapter) Mutate() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.step++
	skus := make([]string, 0, len(a.products))
	for s := range a.products {
		skus = append(skus, s)
	}
	sort.Strings(skus)
	if len(skus) == 0 {
		return nil
	}
	var touched []string
	start := 3 * (a.step - 1)
	for i := 0; i < 3; i++ {
		s := skus[(start+i)%len(skus)]
		p := a.products[s]
		p.PriceUSD = round2(p.PriceUSD * 1.10)
		a.products[s] = p
		touched = append(touched, s)
	}
	for i := 3; i < 5; i++ {
		s := skus[(start+i)%len(skus)]
		p := a.products[s]
		p.Stock = math.Max(0, p.Stock-1)
		a.products[s] = p
		touched = append(touched, s)
	}
	return touched
}
