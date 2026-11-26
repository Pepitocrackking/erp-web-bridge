import {
  confirmOrderInputSchema,
  createOrderInputSchema,
  customerSchema,
  EXCHANGE_RATE_MAX,
  ORDER_MAX_LINES,
  ORDER_MAX_QUANTITY,
  pendingOrdersQuerySchema,
  exchangeRateHistoryQuerySchema,
  exchangeRateInputSchema,
  heartbeatResponseSchema,
  heartbeatSchema,
  orderSchema,
  productSchema,
  syncBatchSchema,
  syncResultSchema,
  SYNC_BATCH_MAX_RECORDS,
} from "./index";

const product = {
  sku: "P00001",
  name: "Harina de maiz 1kg",
  category: "Alimentos",
  price_usd: 1.25,
  stock: 120,
  active: true,
};

const customer = {
  customer_code: "C00001",
  tax_id: "J-12345678-9",
  business_name: "Distribuidora La Esquina C.A.",
  credit_limit_usd: 5000,
  current_debt_usd: 1200.5,
  active: true,
};

const order = {
  customer_code: "C00001",
  items: [{ sku: "P00001", quantity: 10, unit_price_usd: 1.25 }],
  total_usd: 12.5,
  exchange_rate_used: 36.5,
  status: "pending_sync",
};

describe("productSchema", () => {
  it("acepta un producto valido", () => {
    expect(productSchema.parse(product)).toEqual(product);
  });

  it("acepta categoria nula (producto sin categoria en el ERP)", () => {
    expect(productSchema.safeParse({ ...product, category: null }).success).toBe(true);
  });

  it.each([
    ["sku vacio", { sku: "" }],
    ["nombre vacio", { name: "" }],
    ["precio negativo", { price_usd: -1 }],
    ["precio NaN", { price_usd: Number.NaN }],
    ["stock negativo", { stock: -5 }],
    ["precio como texto", { price_usd: "1.25" }],
  ])("rechaza %s", (_label, patch) => {
    expect(productSchema.safeParse({ ...product, ...patch }).success).toBe(false);
  });

  it("rechaza campos desconocidos (contrato estricto)", () => {
    expect(productSchema.safeParse({ ...product, costo: 0.5 }).success).toBe(false);
  });
});

describe("customerSchema", () => {
  it("acepta un cliente valido", () => {
    expect(customerSchema.parse(customer)).toEqual(customer);
  });

  it.each([
    ["codigo vacio", { customer_code: "" }],
    ["RIF vacio", { tax_id: "" }],
    ["limite de credito negativo", { credit_limit_usd: -1 }],
    ["deuda infinita", { current_debt_usd: Number.POSITIVE_INFINITY }],
  ])("rechaza %s", (_label, patch) => {
    expect(customerSchema.safeParse({ ...customer, ...patch }).success).toBe(false);
  });
});

describe("orderSchema", () => {
  it("acepta un pedido valido", () => {
    expect(orderSchema.parse(order)).toEqual(order);
  });

  it("acepta la referencia del ERP cuando ya se sincronizo", () => {
    const synced = { ...order, status: "synced_to_erp", erp_order_reference: "PED-0001" };
    expect(orderSchema.parse(synced)).toEqual(synced);
  });

  it.each(["pending_sync", "synced_to_erp", "approved", "rejected", "cancelled", "error"])(
    "acepta el estado %s (los mismos que el CHECK de web_orders.status)",
    (status) => {
      expect(orderSchema.safeParse({ ...order, status }).success).toBe(true);
    },
  );

  it.each([
    ["sin items", { items: [] }],
    ["cantidad cero", { items: [{ sku: "P00001", quantity: 0, unit_price_usd: 1 }] }],
    ["cantidad decimal", { items: [{ sku: "P00001", quantity: 1.5, unit_price_usd: 1 }] }],
    ["tasa cero", { exchange_rate_used: 0 }],
    ["estado desconocido", { status: "borrador" }],
    ["total negativo", { total_usd: -1 }],
  ])("rechaza %s", (_label, patch) => {
    expect(orderSchema.safeParse({ ...order, ...patch }).success).toBe(false);
  });
});

describe("syncBatchSchema", () => {
  const RECONCILIATION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const finalReconciliation = (total: number) => ({
    full_reconciliation: true,
    reconciliation_id: RECONCILIATION_ID,
    final_batch: true,
    total_records: total,
  });
  const base = {
    batch_id: "6f1c2f0e-8d3a-4b7e-9c55-1a2b3c4d5e6f",
    sent_at: "2026-11-26T15:00:00.000Z",
    full_reconciliation: false,
  };

  it("acepta un lote de productos", () => {
    const batch = { ...base, kind: "products", records: [{ ...product, sync_hash: "abc123" }] };
    expect(syncBatchSchema.parse(batch)).toEqual(batch);
  });

  it("acepta un lote de clientes", () => {
    const batch = { ...base, kind: "customers", records: [customer] };
    expect(syncBatchSchema.parse(batch)).toEqual(batch);
  });

  it("acepta un lote vacio (reconciliacion completa de un inventario vacio)", () => {
    const batch = { ...base, kind: "products", ...finalReconciliation(0), records: [] };
    expect(syncBatchSchema.safeParse(batch).success).toBe(true);
  });

  describe("reconciliacion completa en varios lotes", () => {
    it("acepta un lote intermedio: reconciliation_id y final_batch=false, sin total_records", () => {
      const batch = {
        ...base,
        kind: "products",
        full_reconciliation: true,
        reconciliation_id: RECONCILIATION_ID,
        final_batch: false,
        records: [],
      };
      expect(syncBatchSchema.safeParse(batch).success).toBe(true);
    });

    it("acepta el ultimo lote con total_records", () => {
      const batch = { ...base, kind: "customers", ...finalReconciliation(5000), records: [] };
      expect(syncBatchSchema.safeParse(batch).success).toBe(true);
    });

    it.each<[string, Record<string, unknown>]>([
      ["falta reconciliation_id", { reconciliation_id: undefined }],
      ["falta final_batch", { final_batch: undefined }],
      ["el ultimo lote no trae total_records", { total_records: undefined }],
      ["reconciliation_id no es UUID", { reconciliation_id: "abc" }],
      ["total_records negativo", { total_records: -1 }],
      ["total_records no entero", { total_records: 1.5 }],
    ])("rechaza si %s", (_label, patch) => {
      const batch = {
        ...base,
        kind: "products",
        ...finalReconciliation(10),
        ...patch,
        records: [],
      };
      expect(syncBatchSchema.safeParse(batch).success).toBe(false);
    });

    it("rechaza un lote intermedio con total_records", () => {
      const batch = {
        ...base,
        kind: "products",
        ...finalReconciliation(10),
        final_batch: false,
        records: [],
      };
      expect(syncBatchSchema.safeParse(batch).success).toBe(false);
    });

    it("rechaza campos de reconciliacion cuando full_reconciliation es false", () => {
      for (const extra of [
        { reconciliation_id: RECONCILIATION_ID },
        { final_batch: true },
        { total_records: 3 },
      ]) {
        const batch = { ...base, kind: "products", ...extra, records: [] };
        expect(syncBatchSchema.safeParse(batch).success).toBe(false);
      }
    });
  });

  it("rechaza un lote de productos con un registro de cliente", () => {
    const batch = { ...base, kind: "products", records: [customer] };
    expect(syncBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("rechaza un producto sin sync_hash dentro de un lote", () => {
    const batch = { ...base, kind: "products", records: [product] };
    expect(syncBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("rechaza batch_id que no es UUID y fecha invalida", () => {
    const batch = { ...base, batch_id: "123", kind: "customers", records: [] };
    expect(syncBatchSchema.safeParse(batch).success).toBe(false);
    expect(
      syncBatchSchema.safeParse({ ...base, sent_at: "ayer", kind: "customers", records: [] })
        .success,
    ).toBe(false);
  });

  it("rechaza lotes que superan el maximo de registros", () => {
    const records = Array.from({ length: SYNC_BATCH_MAX_RECORDS + 1 }, () => customer);
    expect(syncBatchSchema.safeParse({ ...base, kind: "customers", records }).success).toBe(false);
  });

  it("rechaza un tipo de lote desconocido", () => {
    expect(syncBatchSchema.safeParse({ ...base, kind: "orders", records: [] }).success).toBe(false);
  });
});

describe("syncResultSchema", () => {
  const result = {
    batch_id: "6f1c2f0e-8d3a-4b7e-9c55-1a2b3c4d5e6f",
    duplicate: false,
    received: 3,
    inserted: 1,
    updated: 1,
    unchanged: 1,
    deactivated: null,
  };

  it("acepta un resultado normal y uno de reenvio sin desglose", () => {
    expect(syncResultSchema.safeParse(result).success).toBe(true);
    const dup = { ...result, duplicate: true, inserted: null, updated: null, unchanged: null };
    expect(syncResultSchema.safeParse(dup).success).toBe(true);
  });

  it("rechaza conteos negativos o campos de mas", () => {
    expect(syncResultSchema.safeParse({ ...result, inserted: -1 }).success).toBe(false);
    expect(syncResultSchema.safeParse({ ...result, extra: 1 }).success).toBe(false);
  });
});

describe("heartbeatSchema", () => {
  it("acepta el minimo y el completo", () => {
    expect(heartbeatSchema.safeParse({ agent_version: "0.1.0" }).success).toBe(true);
    expect(
      heartbeatSchema.safeParse({ agent_version: "0.1.0", queue_depth: 3, last_error: "sin red" })
        .success,
    ).toBe(true);
    expect(heartbeatSchema.safeParse({ agent_version: "0.1.0", last_error: null }).success).toBe(
      true,
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ["sin version", {}],
    ["version vacia", { agent_version: "  " }],
    ["version demasiado larga", { agent_version: "x".repeat(65) }],
    ["cola negativa", { agent_version: "1", queue_depth: -1 }],
    ["cola decimal", { agent_version: "1", queue_depth: 1.5 }],
    ["error demasiado largo", { agent_version: "1", last_error: "x".repeat(501) }],
    ["campo extra", { agent_version: "1", org_id: "x" }],
  ])("rechaza %s", (_label, body) => {
    expect(heartbeatSchema.safeParse(body).success).toBe(false);
  });

  it("la respuesta exige ok=true y una fecha", () => {
    const now = new Date().toISOString();
    expect(heartbeatResponseSchema.safeParse({ ok: true, server_time: now }).success).toBe(true);
    expect(heartbeatResponseSchema.safeParse({ ok: false, server_time: now }).success).toBe(false);
  });
});

describe("tasa de cambio", () => {
  it("acepta una tasa positiva con hasta el maximo de NUMERIC(12,4)", () => {
    expect(exchangeRateInputSchema.safeParse({ rate_bs: 36.5 }).success).toBe(true);
    expect(exchangeRateInputSchema.safeParse({ rate_bs: 0.0001 }).success).toBe(true);
    expect(exchangeRateInputSchema.safeParse({ rate_bs: EXCHANGE_RATE_MAX }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ["cero", { rate_bs: 0 }],
    ["negativa", { rate_bs: -1 }],
    ["texto", { rate_bs: "36.5" }],
    ["nula", { rate_bs: null }],
    ["infinita", { rate_bs: Infinity }],
    ["mayor al maximo", { rate_bs: EXCHANGE_RATE_MAX + 1 }],
    ["sin campo", {}],
    ["con source", { rate_bs: 36, source: "bcv" }],
    ["con set_by", { rate_bs: 36, set_by: "6f1c2f0e-8d3a-4b7e-9c55-1a2b3c4d5e6f" }],
    ["con org_id", { rate_bs: 36, org_id: "6f1c2f0e-8d3a-4b7e-9c55-1a2b3c4d5e6f" }],
  ])("rechaza %s", (_label, body) => {
    expect(exchangeRateInputSchema.safeParse(body).success).toBe(false);
  });

  it("la consulta del historial convierte textos, aplica valores por defecto y limita", () => {
    expect(exchangeRateHistoryQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(exchangeRateHistoryQuerySchema.parse({ limit: "10", offset: "5" })).toEqual({
      limit: 10,
      offset: 5,
    });
    for (const bad of [
      { limit: "0" },
      { limit: "201" },
      { offset: "-1" },
      { limit: "x" },
      { otro: "1" },
    ]) {
      expect(exchangeRateHistoryQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("createOrderInputSchema", () => {
  const ok = { items: [{ sku: "P1", quantity: 2 }], notes: "Entregar en la tarde" };

  it("acepta un pedido con y sin notas", () => {
    expect(createOrderInputSchema.safeParse(ok).success).toBe(true);
    expect(createOrderInputSchema.safeParse({ items: ok.items }).success).toBe(true);
  });

  it("acepta el maximo de lineas y de unidades", () => {
    const lines = Array.from({ length: ORDER_MAX_LINES }, (_, i) => ({
      sku: `P${i}`,
      quantity: ORDER_MAX_QUANTITY,
    }));
    expect(createOrderInputSchema.safeParse({ items: lines }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ["sin items", {}],
    ["items vacio", { items: [] }],
    [
      "mas lineas que el maximo",
      {
        items: Array.from({ length: ORDER_MAX_LINES + 1 }, (_, i) => ({
          sku: `P${i}`,
          quantity: 1,
        })),
      },
    ],
    ["cantidad cero", { items: [{ sku: "P1", quantity: 0 }] }],
    ["cantidad negativa", { items: [{ sku: "P1", quantity: -1 }] }],
    ["cantidad decimal", { items: [{ sku: "P1", quantity: 1.5 }] }],
    ["cantidad como texto", { items: [{ sku: "P1", quantity: "2" }] }],
    ["cantidad sobre el maximo", { items: [{ sku: "P1", quantity: ORDER_MAX_QUANTITY + 1 }] }],
    ["sku vacio", { items: [{ sku: " ", quantity: 1 }] }],
    [
      "precio enviado por el cliente",
      { items: [{ sku: "P1", quantity: 1, unit_price_usd: 0.01 }] },
    ],
    ["total enviado por el cliente", { items: ok.items, total_usd: 1 }],
    ["cliente enviado por el cliente", { items: ok.items, customer_id: "x" }],
    ["estado enviado por el cliente", { items: ok.items, status: "approved" }],
    ["notas vacias", { items: ok.items, notes: " " }],
    ["notas demasiado largas", { items: ok.items, notes: "x".repeat(501) }],
  ])("rechaza %s", (_label, body) => {
    expect(createOrderInputSchema.safeParse(body).success).toBe(false);
  });
});

describe("confirmacion de pedidos y consulta de pendientes", () => {
  it("la confirmacion exige solo una referencia no vacia de hasta 64 caracteres", () => {
    expect(confirmOrderInputSchema.safeParse({ erp_order_reference: "PED-000123" }).success).toBe(
      true,
    );
    for (const bad of [
      {},
      { erp_order_reference: " " },
      { erp_order_reference: "x".repeat(65) },
      { erp_order_reference: "A", status: "approved" },
      { erp_order_reference: 5 },
    ]) {
      expect(confirmOrderInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("limit de pendientes: 100 por defecto, entre 1 y 500", () => {
    expect(pendingOrdersQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(pendingOrdersQuerySchema.parse({ limit: "500" })).toEqual({ limit: 500 });
    for (const bad of [{ limit: "0" }, { limit: "501" }, { limit: "x" }, { otro: "1" }]) {
      expect(pendingOrdersQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});
