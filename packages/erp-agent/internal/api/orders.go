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
