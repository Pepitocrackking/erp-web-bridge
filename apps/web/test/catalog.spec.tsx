import {
  CATALOG_PAGE_SIZE,
  parseCatalogParams,
  searchFilter,
  stockLabel,
  toCatalogItem,
  unitPriceUsd,
} from "../lib/catalog";

describe("parseCatalogParams", () => {
  it("usa valores por defecto", () => {
    expect(parseCatalogParams({})).toEqual({ q: "", category: "", page: 1 });
  });

  it("recorta el texto, colapsa espacios y toma el primer valor si viene repetido", () => {
    expect(parseCatalogParams({ q: "  harina   pan ", category: ["Alimentos", "x"] })).toEqual({
      q: "harina pan",
      category: "Alimentos",
      page: 1,
    });
  });

  it("la página es un entero >= 1; lo inválido vuelve a 1", () => {
    expect(parseCatalogParams({ page: "3" }).page).toBe(3);
    for (const bad of ["0", "-2", "abc", "1.5", "", "99999999999"]) {
      expect(parseCatalogParams({ page: bad }).page).toBe(1);
    }
  });

  it("limita el texto de búsqueda a 80 caracteres", () => {
    expect(parseCatalogParams({ q: "a".repeat(200) }).q).toHaveLength(80);
  });
});

describe("searchFilter", () => {
  it("devuelve null si no hay texto", () => {
    expect(searchFilter("")).toBeNull();
    expect(searchFilter("   ")).toBeNull();
  });

  it("busca en nombre y SKU con comodines de PostgREST", () => {
    expect(searchFilter("harina")).toBe("name.ilike.*harina*,erp_sku.ilike.*harina*");
  });

  it("neutraliza caracteres que rompen la sintaxis del filtro o son comodines de LIKE", () => {
    const filter = searchFilter('a,b(c)"d%e_f*g\\h:i')!;
    // Solo quedan las dos comas y los puntos propios de la sintaxis del filtro.
    expect(filter).toBe("name.ilike.*abcdefghi*,erp_sku.ilike.*abcdefghi*");
    expect(searchFilter(",()%_*")).toBeNull();
  });

  it("conserva acentos, espacios, guiones y puntos", () => {
    expect(searchFilter("Café-1.5 kg")).toBe(
      "name.ilike.*Café-1.5 kg*,erp_sku.ilike.*Café-1.5 kg*",
    );
  });
});

describe("unitPriceUsd", () => {
  it("el comprador paga el precio de su lista si existe", () => {
    expect(unitPriceUsd("customer", 10, [{ price_usd: 9 }])).toBe(9);
  });

  it("el comprador sin precio en su lista paga el precio base", () => {
    expect(unitPriceUsd("customer", 10, [])).toBe(10);
  });

  it("el personal ve el precio base, aunque vea varias listas", () => {
    expect(unitPriceUsd("staff", 10, [{ price_usd: 9 }, { price_usd: 8 }])).toBe(10);
    expect(unitPriceUsd("owner", 10, [{ price_usd: 9 }])).toBe(10);
  });
});

describe("stockLabel", () => {
  it("distingue agotado, pocas unidades y disponible", () => {
    expect(stockLabel(0)).toEqual({ text: "Agotado", level: "out" });
    expect(stockLabel(4)).toEqual({ text: "Quedan 4", level: "low" });
    expect(stockLabel(2.5)).toEqual({ text: "Quedan 2,5", level: "low" });
    expect(stockLabel(120)).toEqual({ text: "Disponible", level: "ok" });
  });
});

describe("toCatalogItem", () => {
  const row = {
    id: "p1",
    erp_sku: "P00001",
    name: "Harina",
    description: null,
    category: "Alimentos",
    image_urls: ["https://example.com/a.jpg"],
    price_usd: 10,
    stock: 50,
    product_prices: [{ price_usd: 9 }],
  };

  it("calcula USD según el rol y Bs con la tasa", () => {
    expect(toCatalogItem(row, "customer", 36.5)).toMatchObject({
      sku: "P00001",
      priceUsd: 9,
      priceBs: 328.5,
      imageUrl: "https://example.com/a.jpg",
      stock: { level: "ok" },
    });
    expect(toCatalogItem(row, "admin", 36.5)).toMatchObject({ priceUsd: 10, priceBs: 365 });
  });

  it("sin imagen, imageUrl es null", () => {
    expect(toCatalogItem({ ...row, image_urls: [] }, "customer", 36.5).imageUrl).toBeNull();
  });
});

it("el tamaño de página es razonable", () => {
  expect(CATALOG_PAGE_SIZE).toBeGreaterThanOrEqual(12);
});
