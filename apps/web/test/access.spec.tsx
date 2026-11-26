import { accessErrorMessage, normalizeTaxId, suggestCustomer } from "../lib/access";

describe("normalizeTaxId (igual que private.normalize_tax_id en SQL)", () => {
  it("quita separadores y pasa a mayúsculas", () => {
    expect(normalizeTaxId("j-30.000001-1")).toBe("J300000011");
    expect(normalizeTaxId(" V 12345678 ")).toBe("V12345678");
    expect(normalizeTaxId("")).toBe("");
    expect(normalizeTaxId(null)).toBe("");
  });
});

describe("suggestCustomer", () => {
  const customers = [
    { id: "a", code: "C1", name: "Uno", taxId: "J-30000001-1" },
    { id: "b", code: "C2", name: "Dos", taxId: "J-30000002-2" },
    { id: "c", code: "C3", name: "Tres", taxId: "j300000022" },
  ];

  it("sugiere el cliente cuyo RIF coincide", () => {
    expect(suggestCustomer("j-30000001-1", customers)).toBe("a");
  });

  it("no sugiere si no hay coincidencia o es ambigua (dos clientes con el mismo RIF)", () => {
    expect(suggestCustomer("J-99999999-9", customers)).toBeNull();
    expect(suggestCustomer("J-30000002-2", customers)).toBeNull();
  });
});

describe("accessErrorMessage", () => {
  it("traduce los códigos de la base a mensajes en español", () => {
    expect(accessErrorMessage("org_not_found")).toMatch(/empresa/i);
    expect(accessErrorMessage("already_member")).toMatch(/ya tienes acceso/i);
    expect(accessErrorMessage("no_matching_customer")).toMatch(/RIF/);
    expect(accessErrorMessage("forbidden")).toMatch(/permiso/i);
  });

  it("un error desconocido no filtra detalles internos", () => {
    expect(accessErrorMessage('relation "x" does not exist')).toBe(
      "No se pudo completar la operación. Inténtalo de nuevo.",
    );
    expect(accessErrorMessage(undefined)).toBe(
      "No se pudo completar la operación. Inténtalo de nuevo.",
    );
  });
});
