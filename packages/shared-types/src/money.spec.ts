import { formatBs, formatUsd, usdToBs } from "./index";

describe("usdToBs", () => {
  it("multiplica por la tasa y redondea a 2 decimales", () => {
    expect(usdToBs(10, 36.5)).toBe(365);
    expect(usdToBs(1.25, 36.5)).toBe(45.63); // 45.625 redondea hacia arriba (mitad hacia arriba)
    expect(usdToBs(0.01, 36.5)).toBe(0.37); // 0.365
  });

  it("no arrastra errores de coma flotante", () => {
    // 1.005 * 100 = 100.49999999999999 en coma flotante; el dinero se calcula en enteros.
    expect(usdToBs(1.005, 1)).toBe(1.01);
    expect(usdToBs(0.1 + 0.2, 1)).toBe(0.3);
    expect(usdToBs(19.99, 36.1234)).toBe(722.11); // 722.106766 -> 722.11
  });

  it("admite tasas con 4 decimales", () => {
    expect(usdToBs(100, 36.1234)).toBe(3612.34);
    expect(usdToBs(3, 0.3333)).toBe(1);
  });

  it("devuelve 0 para precio 0 y respeta importes grandes", () => {
    expect(usdToBs(0, 36.5)).toBe(0);
    expect(usdToBs(9_999_999_999.99, 99_999_999.9999)).toBeGreaterThan(0);
    expect(usdToBs(1_000_000, 36.5)).toBe(36_500_000);
  });

  it("rechaza entradas no válidas", () => {
    expect(() => usdToBs(-1, 36.5)).toThrow(RangeError);
    expect(() => usdToBs(1, 0)).toThrow(RangeError);
    expect(() => usdToBs(1, -3)).toThrow(RangeError);
    expect(() => usdToBs(Number.NaN, 36.5)).toThrow(RangeError);
    expect(() => usdToBs(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formateo", () => {
  it("formatUsd usa símbolo $ y 2 decimales", () => {
    expect(formatUsd(1234.5)).toBe("$ 1.234,50");
  });

  it("formatBs usa Bs. y separadores venezolanos", () => {
    expect(formatBs(45.63)).toBe("Bs. 45,63");
    expect(formatBs(36_500_000)).toBe("Bs. 36.500.000,00");
  });
});
