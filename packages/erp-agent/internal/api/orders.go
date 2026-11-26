package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// OrderItem es un renglón de un pedido web.
type OrderItem struct {
	SKU          string  `json:"sku"`
	Quantity     int     `json:"quantity"`
	UnitPriceUSD float64 `json:"unit_price_usd"`
}

// Order es un pedido web tal como lo devuelve GET /v1/orders/pending.
type Order struct {
	ID               string      `json:"id"`
	CustomerCode     string      `json:"customer_code"`
	Status           string      `json:"status"`
	TotalUSD         float64     `json:"total_usd"`
	ExchangeRateUsed float64     `json:"exchange_rate_used"`
	Items            []OrderItem `json:"items"`
	ERPOrderRef      *string     `json:"erp_order_reference"`
	Notes            *string     `json:"notes"`
	CreatedAt        string      `json:"created_at"`
}

// ConfirmResult es la respuesta de POST /v1/orders/:id/confirm.
type ConfirmResult struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Reference string `json:"erp_order_reference"`
	Duplicate bool   `json:"duplicate"`
}

// ConfirmOrder avisa a la API que el borrador ya existe en el ERP con esa referencia. Es
// idempotente: confirmar otra vez con la misma referencia devuelve Duplicate=true.
func (c *Client) ConfirmOrder(ctx context.Context, orderID, reference string) (*ConfirmResult, error) {
	body, _ := json.Marshal(map[string]string{"erp_order_reference": reference})
	raw, err := c.post(ctx, "/v1/orders/"+orderID+"/confirm", body)
	if err != nil {
		return nil, err
	}
	var res ConfirmResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, &Error{Status: 0, Message: "respuesta ilegible: " + err.Error(), Err: err}
	}
	return &res, nil
}

// MaxErrorDetail es el largo máximo del motivo que acepta la API.
const MaxErrorDetail = 1000

// FailOrder informa que el ERP no puede aceptar el pedido y que reintentar no lo arregla. La API
// lo pasa a "error" con el motivo. Es idempotente.
func (c *Client) FailOrder(ctx context.Context, orderID, detail string) error {
	r := []rune(detail)
	if len(r) > MaxErrorDetail {
		detail = string(r[:MaxErrorDetail])
	}
	body, _ := json.Marshal(map[string]string{"error_detail": detail})
	_, err := c.post(ctx, "/v1/orders/"+orderID+"/fail", body)
	return err
}

// PendingOrders consulta los pedidos en pending_sync, los más antiguos primero. No modifica nada.
func (c *Client) PendingOrders(ctx context.Context, limit int) ([]Order, error) {
	raw, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/v1/orders/pending?limit=%d", limit), nil)
	if err != nil {
		return nil, err
	}
	var res struct {
		Orders []Order `json:"orders"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, &Error{Status: 0, Message: "respuesta ilegible: " + err.Error(), Err: err}
	}
	return res.Orders, nil
}
