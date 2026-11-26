-- Fase 4 (API, tarea 4.6): pedidos.

-- Una referencia del ERP identifica un solo pedido de la organización. Si el agente confirmara
-- dos pedidos distintos con la misma referencia (un error suyo), el segundo se rechaza en lugar
-- de duplicar o mezclar borradores.
CREATE UNIQUE INDEX web_orders_erp_reference_uniq
  ON public.web_orders (org_id, erp_order_reference)
  WHERE erp_order_reference IS NOT NULL;

-- GET /v1/orders/pending (pedidos por enviar, los más antiguos primero) y la suma de exposición
-- de crédito de un cliente.
CREATE INDEX web_orders_org_status_created_idx ON public.web_orders (org_id, status, created_at);
CREATE INDEX web_orders_customer_status_idx ON public.web_orders (customer_id, status);
