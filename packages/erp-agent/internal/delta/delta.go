// Package delta calcula los hashes y el diff de la sincronización diferencial:
// solo se envían a la nube los registros que cambiaron desde el último envío.
//
// # Forma canónica del hash (contrato estable: NO cambiarla sin migrar la base)
//
// sync_hash = hex minúscula de SHA-256 sobre los bytes UTF-8 de
//
//		sku \x1f precio \x1f stock \x1f nombre
//
//	  - \x1f (separador de unidades, 0x1F) no aparece en datos de ERP.
//	  - precio y stock en notación decimal con EXACTAMENTE 2 decimales
//	    (como NUMERIC(12,2) en la base), redondeados half-away-from-zero, p. ej.
//	    "2.09", "264.00". Saint guarda 4 decimales; si no se redondeara antes, el
//	    hash cambiaría sin que cambie lo guardado en la nube.
//	  - sku y nombre sin espacios al inicio ni al final.
//
// # Huella (fingerprint) de cambios
//
// El hash del contrato cubre solo sku+precio+stock+nombre. Pero un cambio de
// categoría o de estado activo también debe llegar a la nube, así que el diff
// compara una huella que incluye además categoría y activo. El sync_hash que
// viaja a la API es siempre el del contrato.
package delta

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"strconv"
	"strings"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

const sep = "\x1f"

// Round2 redondea a 2 decimales (mitad lejos de cero) y elimina el -0.
func Round2(v float64) float64 {
	r := math.Round(v*100) / 100
	if r == 0 {
		return 0
	}
	return r
}

func dec2(v float64) string { return strconv.FormatFloat(Round2(v), 'f', 2, 64) }

func sum(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, sep)))
	return hex.EncodeToString(h[:])
}

// NormalizeProduct deja el producto tal como se guardará en la nube: textos
// recortados e importes a 2 decimales.
func NormalizeProduct(p erp.Product) erp.Product {
	p.SKU = strings.TrimSpace(p.SKU)
	p.Name = strings.TrimSpace(p.Name)
	p.PriceUSD = Round2(p.PriceUSD)
	p.Stock = Round2(p.Stock)
	if p.Category != nil {
		c := strings.TrimSpace(*p.Category)
		if c == "" {
			p.Category = nil
		} else {
			p.Category = &c
		}
	}
	return p
}

// SyncHash es el hash del contrato (sku + precio + stock + nombre).
func SyncHash(p erp.Product) string {
	p = NormalizeProduct(p)
	return sum(p.SKU, dec2(p.PriceUSD), dec2(p.Stock), p.Name)
}

func b2s(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// ProductFingerprint detecta cualquier cambio relevante de un producto.
func ProductFingerprint(p erp.Product) string {
	p = NormalizeProduct(p)
	cat := ""
	if p.Category != nil {
		cat = *p.Category
	}
	return sum(SyncHash(p), cat, b2s(p.Active))
}

// CustomerFingerprint detecta cualquier cambio de un cliente.
func CustomerFingerprint(c erp.Customer) string {
	c = NormalizeCustomer(c)
	return sum(c.CustomerCode, c.TaxID, c.BusinessName, dec2(c.CreditLimitUSD), dec2(c.CurrentDebtUSD), b2s(c.Active))
}

// NormalizeCustomer deja el cliente tal como se guardará en la nube.
func NormalizeCustomer(c erp.Customer) erp.Customer {
	c.CustomerCode = strings.TrimSpace(c.CustomerCode)
	c.TaxID = strings.TrimSpace(c.TaxID)
	c.BusinessName = strings.TrimSpace(c.BusinessName)
	c.CreditLimitUSD = Round2(c.CreditLimitUSD)
	c.CurrentDebtUSD = Round2(c.CurrentDebtUSD)
	return c
}

// ProductDiff es el resultado de comparar el ERP contra lo ya enviado.
type ProductDiff struct {
	Changed      []erp.ProductRecord // lo que hay que enviar, en orden de entrada
	Fingerprints map[string]string   // sku -> huella nueva, SOLO de Changed (se persiste tras la entrega)
	Unchanged    int
}

// DiffProducts compara los productos actuales con las huellas conocidas
// (sku -> huella). Los productos nuevos y los modificados van en Changed.
func DiffProducts(current []erp.Product, known map[string]string) ProductDiff {
	d := ProductDiff{Fingerprints: map[string]string{}}
	for _, p := range current {
		n := NormalizeProduct(p)
		fp := ProductFingerprint(n)
		if known[n.SKU] == fp {
			d.Unchanged++
			continue
		}
		d.Changed = append(d.Changed, erp.ProductRecord{Product: n, SyncHash: SyncHash(n)})
		d.Fingerprints[n.SKU] = fp
	}
	return d
}

// CustomerDiff es el resultado de comparar clientes.
type CustomerDiff struct {
	Changed      []erp.Customer
	Fingerprints map[string]string // customer_code -> huella nueva, solo de Changed
	Unchanged    int
}

// DiffCustomers compara los clientes actuales con las huellas conocidas.
func DiffCustomers(current []erp.Customer, known map[string]string) CustomerDiff {
	d := CustomerDiff{Fingerprints: map[string]string{}}
	for _, c := range current {
		n := NormalizeCustomer(c)
		fp := CustomerFingerprint(n)
		if known[n.CustomerCode] == fp {
			d.Unchanged++
			continue
		}
		d.Changed = append(d.Changed, n)
		d.Fingerprints[n.CustomerCode] = fp
	}
	return d
}
