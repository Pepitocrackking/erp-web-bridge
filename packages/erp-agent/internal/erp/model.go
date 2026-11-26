// Package erp define el modelo canónico del agente y la interfaz ERPAdapter
// que implementan los adaptadores (Saint, Mock, y más adelante Odoo).
//
// El modelo es un espejo de los contratos de packages/shared-types/src/contracts.ts:
// mismos nombres de campo en JSON (snake_case). Los importes viajan siempre en USD.
package erp

// Product es un producto canónico leído del ERP.
type Product struct {
	SKU      string  `json:"sku"`
	Name     string  `json:"name"`
	Category *string `json:"category,omitempty"`
	PriceUSD float64 `json:"price_usd"`
	Stock    float64 `json:"stock"`
	Active   bool    `json:"active"`
}

// ProductRecord es un producto dentro de un lote de sincronización: el
// producto más el hash que calcula el agente (ver la tarea 5.4).
type ProductRecord struct {
	Product
	SyncHash string `json:"sync_hash"`
}

// Customer es un cliente B2B canónico leído del ERP.
type Customer struct {
	CustomerCode   string  `json:"customer_code"`
	TaxID          string  `json:"tax_id"`
	BusinessName   string  `json:"business_name"`
	CreditLimitUSD float64 `json:"credit_limit_usd"`
	CurrentDebtUSD float64 `json:"current_debt_usd"`
	Active         bool    `json:"active"`
}
