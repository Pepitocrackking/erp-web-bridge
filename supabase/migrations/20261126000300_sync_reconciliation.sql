-- Fase 4 (API): soporte de reconciliación completa en varios lotes e idempotencia de lotes.

-- Cada fila recibida en una reconciliación se sella con su reconciliation_id. Al llegar el último
-- lote, lo que no lleve ese sello es lo que el ERP ya no envió y se desactiva.
ALTER TABLE public.products ADD COLUMN reconciliation_id UUID;
ALTER TABLE public.b2b_customers ADD COLUMN reconciliation_id UUID;

CREATE INDEX products_org_reconciliation_idx ON public.products (org_id, reconciliation_id);
CREATE INDEX b2b_customers_org_reconciliation_idx ON public.b2b_customers (org_id, reconciliation_id);

-- Un mismo lote (org, entidad, batch_id) no se procesa dos veces con éxito: si el agente reenvía
-- un lote tras perder la respuesta, la API lo reconoce y no repite el trabajo. Los lotes con
-- error no cuentan, para poder reintentarlos con el mismo batch_id.
CREATE UNIQUE INDEX sync_logs_batch_once_idx
  ON public.sync_logs (org_id, entity, batch_id)
  WHERE batch_id IS NOT NULL AND status IN ('success', 'partial');
