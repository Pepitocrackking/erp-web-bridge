import {
  SIMULATOR_MAX_CHANGES,
  changedRows,
  rowErrors,
  simulatorConfig,
  type SimRow,
} from "../lib/simulator";

const row = (sku: string, over: Partial<SimRow> = {}): SimRow => ({
  sku,
  name: `Producto ${sku}`,
  category: "Alimentos",
  priceUsd: 10,
  stock: 5,
  active: true,
  ...over,
});

describe("changedRows", () => {
  const baseline = [row("A"), row("B")];

  it("sin ediciones no hay cambios", () => {
    expect(changedRows(baseline, [row("A"), row("B")])).toEqual([]);
  });

  it("detecta cambios de nombre, precio, existencia, categoría y estado", () => {
    const current = [
      row("A", { name: "Otro nombre" }),
      row("B", { priceUsd: 10.01 }),
      row("C", { stock: 9 }),
    ];
    // C es nuevo; A y B cambiaron.
    expect(changedRows(baseline, current).map((r) => r.sku)).toEqual(["A", "B", "C"]);
    expect(changedRows(baseline, [row("A", { stock: 6 }), row("B")]).map((r) => r.sku)).toEqual([
      "A",
    ]);
    expect(
      changedRows(baseline, [row("A", { category: null }), row("B")]).map((r) => r.sku),
    ).toEqual(["A"]);
    expect(
      changedRows(baseline, [row("A"), row("B", { active: false })]).map((r) => r.sku),
    ).toEqual(["B"]);
  });

  it("compara a 2 decimales y sin espacios sobrantes (lo que viajaría de verdad)", () => {
    expect(changedRows(baseline, [row("A", { priceUsd: 10.004 }), row("B")])).toEqual([]);
    expect(changedRows(baseline, [row("A", { name: "  Producto A  " }), row("B")])).toEqual([]);
    expect(
      changedRows(baseline, [row("A", { priceUsd: 10.006 }), row("B")]).map((r) => r.sku),
    ).toEqual(["A"]);
  });

  it("devolver un valor a su original deja de ser un cambio", () => {
    expect(changedRows(baseline, [row("A", { priceUsd: 12 }), row("B")])).toHaveLength(1);
    expect(changedRows(baseline, [row("A", { priceUsd: 10 }), row("B")])).toHaveLength(0);
  });
});

describe("rowErrors", () => {
  it("una fila correcta no tiene errores", () => {
    expect(rowErrors(row("A"))).toEqual([]);
  });

  it("valida código, nombre, precio y existencia", () => {
    expect(rowErrors(row("  "))).toContain("Falta el código.");
    expect(rowErrors(row("A", { name: " " }))).toContain("Falta el nombre.");
    expect(rowErrors(row("A", { priceUsd: -1 }))).toContain("El precio debe ser 0 o más.");
    expect(rowErrors(row("A", { priceUsd: Number.NaN }))).toContain("El precio debe ser 0 o más.");
    expect(rowErrors(row("A", { stock: -2 }))).toContain("La existencia debe ser 0 o más.");
    expect(rowErrors(row("A", { priceUsd: 1e12 }))).toContain("El precio es demasiado grande.");
  });
});

describe("simulatorConfig", () => {
  it("sin clave ni modo demo está apagado", () => {
    expect(simulatorConfig({})).toBeNull();
  });

  it("con SIMULATOR_API_KEY usa esa clave y la organización indicada", () => {
    expect(
      simulatorConfig({ SIMULATOR_API_KEY: "mi_clave", SIMULATOR_ORG_SLUG: "mi-org" }),
    ).toEqual({ apiKey: "mi_clave", orgSlug: "mi-org" });
  });

  it("en modo demo usa la clave de desarrollo del seed", () => {
    expect(simulatorConfig({ DEMO_MODE: "true" })).toEqual({
      apiKey: "erp_dev_demo_saint_key",
      orgSlug: "demo-saint",
    });
  });

  it("el máximo de cambios por envío es razonable", () => {
    expect(SIMULATOR_MAX_CHANGES).toBeGreaterThanOrEqual(50);
  });
});
