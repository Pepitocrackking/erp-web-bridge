import {
  customerSchema,
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
