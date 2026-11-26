import { ORDER_MAX_LINES, ORDER_MAX_QUANTITY } from "@erp-web-bridge/shared-types";
import { addItem, parseCart, removeItem, serializeCart, setQuantity } from "../lib/cart";
import { mapOrderError } from "../lib/orders";
import { buildQuote, creditInfo } from "../lib/quote";
import type { ProductRow } from "../lib/catalog";

describe("carrito", () => {
  it("agregar suma a la línea existente y crea las nuevas", () => {
    let cart = addItem([], "A", 2);
    cart = addItem(cart, "B", 1);
    cart = addItem(cart, "A", 3);
    expect(cart).toEqual([
      { sku: "A", quantity: 5 },
      { sku: "B", quantity: 1 },
    ]);
  });

  it("respeta los máximos del pedido", () => {
    expect(addItem([{ sku: "A", quantity: ORDER_MAX_QUANTITY }], "A", 5)[0]!.quantity).toBe(
      ORDER_MAX_QUANTITY,
    );
    const full = Array.from({ length: ORDER_MAX_LINES }, (_, i) => ({ sku: `S${i}`, quantity: 1 }));
    expect(addItem(full, "NUEVO", 1)).toHaveLength(ORDER_MAX_LINES);
    expect(addItem(full, "S0", 1)[0]!.quantity).toBe(2);
  });

  it("ignora cantidades no válidas al agregar", () => {
    expect(addItem([], "A", 0)).toEqual([]);
    expect(addItem([], "A", -3)).toEqual([]);
    expect(addItem([], "A", Number.NaN)).toEqual([]);
    expect(addItem([], "A", 2.9)).toEqual([{ sku: "A", quantity: 2 }]);
  });

  it("setQuantity cambia la cantidad y quita la línea con 0 o menos", () => {
    const cart = [
      { sku: "A", quantity: 2 },
      { sku: "B", quantity: 1 },
    ];
    expect(setQuantity(cart, "A", 7)).toEqual([
      { sku: "A", quantity: 7 },
      { sku: "B", quantity: 1 },
    ]);
    expect(setQuantity(cart, "A", 0)).toEqual([{ sku: "B", quantity: 1 }]);
    expect(setQuantity(cart, "A", Number.NaN)).toEqual([{ sku: "B", quantity: 1 }]);
    expect(removeItem(cart, "B")).toEqual([{ sku: "A", quantity: 2 }]);
  });

  it("serializar y leer es una ida y vuelta", () => {
    const cart = [{ sku: "A", quantity: 2 }];
    expect(parseCart(serializeCart(cart))).toEqual(cart);
  });

  it("parseCart tolera valores corruptos o manipulados", () => {
    expect(parseCart(null)).toEqual([]);
    expect(parseCart("")).toEqual([]);
    expect(parseCart("{no es json")).toEqual([]);
    expect(parseCart('{"sku":"A"}')).toEqual([]);
    expect(
      parseCart(
        JSON.stringify([
          { sku: "A", quantity: 2 },
          { sku: "A", quantity: 9 }, // repetido
          { sku: "", quantity: 1 },
          { sku: "B", quantity: "3" },
          { sku: "C", quantity: -1 },
          { sku: "D", quantity: 1e12 }, // se limita al máximo
          { sku: "E", quantity: 2.7 },
          null,
          "x",
        ]),
      ),
    ).toEqual([
      { sku: "A", quantity: 2 },
      { sku: "D", quantity: ORDER_MAX_QUANTITY },
      { sku: "E", quantity: 2 },
    ]);
  });
});

const row = (sku: string, price: number, stock: number, listPrice?: number): ProductRow => ({
  id: sku,
  erp_sku: sku,
  name: `Producto ${sku}`,
  description: null,
  category: null,
  image_urls: [],
  price_usd: price,
  stock,
  product_prices: listPrice === undefined ? [] : [{ price_usd: listPrice }],
});

describe("creditInfo", () => {
  it("disponible = límite - deuda - pendientes, sin negativos ni errores de coma flotante", () => {
    expect(creditInfo(5000, 1200.5, 25)).toMatchObject({ availableUsd: 3774.5 });
    expect(creditInfo(0.3, 0.1, 0.1)).toMatchObject({ availableUsd: 0.1 });
    expect(creditInfo(1000, 1250, 0).availableUsd).toBe(0); // deuda por encima del límite
  });
});

describe("buildQuote", () => {
  const rows = [row("A", 10, 100, 9), row("B", 2.5, 3)];
  const credit = creditInfo(1000, 900, 50); // disponible 50

  it("usa el precio de la lista, suma en centavos y convierte a Bs", () => {
    const quote = buildQuote({
      items: [
        { sku: "A", quantity: 4 }, // 9 x 4 = 36
        { sku: "B", quantity: 2 }, // 2,5 x 2 = 5
      ],
      rows,
      rateBs: 36.5,
      credit,
    });
    expect(quote.lines.map((l) => [l.sku, l.unitUsd, l.lineUsd, l.lineBs])).toEqual([
      ["A", 9, 36, 1314],
      ["B", 2.5, 5, 182.5],
    ]);
    expect(quote.totalUsd).toBe(41);
    expect(quote.totalBs).toBe(1496.5);
    expect(quote.exceedsCredit).toBe(false);
    expect(quote.overByUsd).toBe(0);
  });

  it("el total igual al crédito disponible se acepta; un centavo más, no", () => {
    const exact = buildQuote({ items: [{ sku: "A", quantity: 5 }], rows, rateBs: 36.5, credit }); // 45
    expect(exact.exceedsCredit).toBe(false);
    const edge = buildQuote({
      items: [{ sku: "B", quantity: 20 }], // 50 exactos
      rows: [row("B", 2.5, 100)],
      rateBs: 36.5,
      credit,
    });
    expect(edge.totalUsd).toBe(50);
    expect(edge.exceedsCredit).toBe(false);
    const over = buildQuote({
      items: [{ sku: "B", quantity: 1 }],
      rows: [row("B", 0.01, 100)],
      rateBs: 36.5,
      credit: creditInfo(100, 99.99, 0), // disponible 0,01
    });
    expect(over.exceedsCredit).toBe(false);
    const overByOne = buildQuote({
      items: [{ sku: "B", quantity: 2 }],
      rows: [row("B", 0.01, 100)],
      rateBs: 36.5,
      credit: creditInfo(100, 99.99, 0),
    });
    expect(overByOne.exceedsCredit).toBe(true);
    expect(overByOne.overByUsd).toBe(0.01);
  });

  it("marca el exceso de crédito y cuánto se pasa", () => {
    const quote = buildQuote({ items: [{ sku: "A", quantity: 10 }], rows, rateBs: 36.5, credit }); // 90
    expect(quote.exceedsCredit).toBe(true);
    expect(quote.overByUsd).toBe(40);
  });

  it("separa los SKU que ya no están disponibles y avisa de la existencia", () => {
    const quote = buildQuote({
      items: [
        { sku: "B", quantity: 5 }, // solo hay 3
        { sku: "FANTASMA", quantity: 1 },
      ],
      rows,
      rateBs: 36.5,
      credit,
    });
    expect(quote.unavailableSkus).toEqual(["FANTASMA"]);
    expect(quote.lines[0]!.stockWarning).toBe("Solo hay 3 en existencia");
    expect(
      buildQuote({ items: [{ sku: "Z", quantity: 1 }], rows: [row("Z", 1, 0)], rateBs: 1, credit })
        .lines[0]!.stockWarning,
    ).toBe("Agotado");
  });

  it("un carrito vacío cuesta 0", () => {
    const quote = buildQuote({ items: [], rows, rateBs: 36.5, credit });
    expect(quote).toMatchObject({ totalUsd: 0, totalBs: 0, exceedsCredit: false });
  });
});

describe("mapOrderError", () => {
  it("credit_limit_exceeded trae los números para explicarlo", () => {
    const failure = mapOrderError(422, {
      code: "credit_limit_exceeded",
      message: "El pedido supera el límite de crédito disponible",
      credit_limit_usd: 5000,
      current_debt_usd: 1200.5,
      pending_orders_usd: 25,
      order_total_usd: 9000,
      available_usd: 3774.5,
    });
    expect(failure).toMatchObject({
      code: "credit_limit_exceeded",
      credit: {
        limitUsd: 5000,
        debtUsd: 1200.5,
        pendingUsd: 25,
        orderTotalUsd: 9000,
        availableUsd: 3774.5,
      },
    });
  });

  it("productos inexistentes o repetidos", () => {
    expect(
      mapOrderError(422, {
        message: "Hay productos inexistentes o inactivos en el pedido",
        skus: ["X"],
      }),
    ).toMatchObject({ code: "unavailable_products", skus: ["X"] });
    expect(
      mapOrderError(422, { message: "SKU repetidos en el pedido", skus: ["A"] }),
    ).toMatchObject({
      code: "repeated_products",
      skus: ["A"],
    });
  });

  it("estados HTTP conocidos y desconocidos", () => {
    expect(mapOrderError(401, {}).code).toBe("unauthorized");
    expect(mapOrderError(403, {}).code).toBe("forbidden");
    expect(mapOrderError(429, {}).code).toBe("rate_limited");
    expect(mapOrderError(400, {}).code).toBe("invalid");
    expect(mapOrderError(500, null).code).toBe("unexpected");
    expect(mapOrderError(422, "texto raro").code).toBe("unexpected");
  });
});
