package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type seen struct {
	method, path, key string
	body              map[string]any
}

func server(t *testing.T, status int, reply string) (*Client, *seen) {
	t.Helper()
	got := &seen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path, got.key = r.Method, r.URL.RequestURI(), r.Header.Get("x-api-key")
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			json.Unmarshal(raw, &got.body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, reply)
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, "clave", "test"), got
}

func TestPendingOrdersPideConLimitYLeeElPedido(t *testing.T) {
	c, got := server(t, 200, `{"orders":[{"id":"abc","customer_code":"C1","status":"pending_sync","total_usd":21.5,
		"exchange_rate_used":40.25,"items":[{"sku":"P1","quantity":3,"unit_price_usd":7.1}],
		"erp_order_reference":null,"notes":null,"created_at":"2026-11-26T00:00:00.000Z"}]}`)
	orders, err := c.PendingOrders(context.Background(), 25)
	if err != nil {
		t.Fatal(err)
	}
	if got.method != http.MethodGet || got.path != "/v1/orders/pending?limit=25" || got.key != "clave" {
		t.Fatalf("petición = %+v", got)
	}
	if len(orders) != 1 || orders[0].ID != "abc" || orders[0].TotalUSD != 21.5 || orders[0].ExchangeRateUsed != 40.25 ||
		orders[0].Notes != nil || len(orders[0].Items) != 1 || orders[0].Items[0] != (OrderItem{SKU: "P1", Quantity: 3, UnitPriceUSD: 7.1}) {
		t.Fatalf("pedidos = %+v", orders)
	}
}

func TestConfirmOrderEnviaLaReferencia(t *testing.T) {
	c, got := server(t, 200, `{"id":"abc","status":"synced_to_erp","erp_order_reference":"PW0000001","synced_at":"2026-11-26T00:00:00.000Z","duplicate":true}`)
	res, err := c.ConfirmOrder(context.Background(), "abc", "PW0000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.method != http.MethodPost || got.path != "/v1/orders/abc/confirm" || got.body["erp_order_reference"] != "PW0000001" || len(got.body) != 1 {
		t.Fatalf("petición = %+v", got)
	}
	if res.Status != "synced_to_erp" || res.Reference != "PW0000001" || !res.Duplicate {
		t.Fatalf("respuesta = %+v", res)
	}
}

func TestFailOrderEnviaElMotivoYLoRecortaAlMaximoDeLaAPI(t *testing.T) {
	c, got := server(t, 200, `{"id":"abc","status":"error","error_detail":"x","duplicate":false}`)
	if err := c.FailOrder(context.Background(), "abc", "el cliente no existe"); err != nil {
		t.Fatal(err)
	}
	if got.path != "/v1/orders/abc/fail" || got.body["error_detail"] != "el cliente no existe" {
		t.Fatalf("petición = %+v", got)
	}
	long := strings.Repeat("ñ", MaxErrorDetail+50) // caracteres de 2 bytes: se recorta por caracteres, no por bytes
	if err := c.FailOrder(context.Background(), "abc", long); err != nil {
		t.Fatal(err)
	}
	if d, _ := got.body["error_detail"].(string); len([]rune(d)) != MaxErrorDetail {
		t.Fatalf("motivo de %d caracteres, quiero %d", len([]rune(d)), MaxErrorDetail)
	}
}

func TestLosErroresDeLaAPISeClasificanParaElProcesador(t *testing.T) {
	for status, want := range map[int]Class{409: Conflict, 404: Invalid, 400: Invalid, 401: Auth, 503: Retry, 429: Retry} {
		c, _ := server(t, status, `{"message":"no"}`)
		_, err := c.ConfirmOrder(context.Background(), "abc", "R")
		if got := Classify(err); got != want {
			t.Errorf("HTTP %d: clase %v, quiero %v", status, got, want)
		}
		if err2 := c.FailOrder(context.Background(), "abc", "m"); Classify(err2) != want {
			t.Errorf("HTTP %d (fail): clase %v, quiero %v", status, Classify(err2), want)
		}
	}
}
