/** @jest-environment node */
import { productSyncHash } from "../lib/sync-hash";

// Los mismos vectores fijos que la prueba del agente Go (packages/erp-agent/internal/delta):
// si estos valores dejan de coincidir, el agente y la web calculan hashes distintos.
describe("productSyncHash (idéntico al del agente Go)", () => {
  it("4 decimales se redondea a 2", () => {
    expect(
      productSyncHash({
        sku: "P00001",
        name: "AGUA MINERAL FRESCOLITA 2 L",
        price_usd: 2.0912,
        stock: 264,
      }),
    ).toBe("5e44f57a3d875a4b92a412a608ea83c6cb4910bb0e2d8a1dd5e58d30026669cb");
  });

  it("unicode y precio entero", () => {
    expect(productSyncHash({ sku: "A", name: "Ñandú café", price_usd: 1.5, stock: 10 })).toBe(
      "00ca2c77eeae47f3c7a3bd1c2c9b545f6176eaddb1f1288e199f88444553b6b4",
    );
  });

  it("ceros", () => {
    expect(productSyncHash({ sku: "X", name: "N", price_usd: 0, stock: 0 })).toBe(
      "6fc783da715a3abb344b9eb6f7e3890ac464129acd141860067d694172f436a2",
    );
  });

  it("los espacios sobrantes se ignoran", () => {
    expect(
      productSyncHash({
        sku: " P00001 ",
        name: "  AGUA MINERAL FRESCOLITA 2 L ",
        price_usd: 2.09,
        stock: 264.004,
      }),
    ).toBe("5e44f57a3d875a4b92a412a608ea83c6cb4910bb0e2d8a1dd5e58d30026669cb");
  });

  it("cambia con cada campo del contrato", () => {
    const base = { sku: "A", name: "N", price_usd: 1, stock: 1 };
    const h = productSyncHash(base);
    expect(productSyncHash({ ...base, sku: "B" })).not.toBe(h);
    expect(productSyncHash({ ...base, name: "M" })).not.toBe(h);
    expect(productSyncHash({ ...base, price_usd: 1.01 })).not.toBe(h);
    expect(productSyncHash({ ...base, stock: 2 })).not.toBe(h);
  });
});
