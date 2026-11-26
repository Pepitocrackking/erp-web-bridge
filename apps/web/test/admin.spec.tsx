import {
  AGENT_ONLINE_WINDOW_MS,
  agentStatus,
  customerAvailableUsd,
  mergeById,
  orderStatusLabel,
  parseRateInput,
  syncEntityLabel,
} from "../lib/admin";

describe("agentStatus", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");

  it("nunca visto si no hay latido", () => {
    expect(agentStatus(null, now)).toEqual({ level: "never", text: "Nunca se ha conectado" });
  });

  it("conectado si el último latido es reciente", () => {
    const recent = new Date(now - 30_000).toISOString();
    expect(agentStatus(recent, now)).toEqual({ level: "online", text: "Conectado" });
    const edge = new Date(now - AGENT_ONLINE_WINDOW_MS + 1).toISOString();
    expect(agentStatus(edge, now).level).toBe("online");
  });

  it("sin conexión si pasó la ventana, y dice hace cuánto", () => {
    expect(agentStatus(new Date(now - AGENT_ONLINE_WINDOW_MS).toISOString(), now)).toMatchObject({
      level: "offline",
    });
    expect(agentStatus(new Date(now - 10 * 60_000).toISOString(), now).text).toBe(
      "Sin conexión desde hace 10 min",
    );
    expect(agentStatus(new Date(now - 3 * 3_600_000).toISOString(), now).text).toBe(
      "Sin conexión desde hace 3 h",
    );
    expect(agentStatus(new Date(now - 50 * 3_600_000).toISOString(), now).text).toBe(
      "Sin conexión desde hace 2 d",
    );
  });

  it("un reloj adelantado (latido en el futuro) cuenta como conectado", () => {
    expect(agentStatus(new Date(now + 60_000).toISOString(), now).level).toBe("online");
  });

  it("una fecha inválida se trata como nunca visto", () => {
    expect(agentStatus("no-es-fecha", now).level).toBe("never");
  });
});

describe("mergeById", () => {
  const a = { id: "a", n: 1 };
  const b = { id: "b", n: 2 };

  it("agrega al principio lo nuevo y reemplaza lo existente en su sitio", () => {
    expect(mergeById([a, b], { id: "c", n: 3 }, 10)).toEqual([{ id: "c", n: 3 }, a, b]);
    expect(mergeById([a, b], { id: "b", n: 99 }, 10)).toEqual([a, { id: "b", n: 99 }]);
  });

  it("respeta el máximo, descartando lo más viejo (el final)", () => {
    expect(mergeById([a, b], { id: "c", n: 3 }, 2)).toEqual([{ id: "c", n: 3 }, a]);
  });

  it("no muta la lista original", () => {
    const list = [a];
    mergeById(list, b, 10);
    expect(list).toEqual([a]);
  });
});

describe("etiquetas", () => {
  it("estados de pedido en español, y un estado desconocido se muestra tal cual", () => {
    expect(orderStatusLabel("pending_sync")).toBe("Pendiente de enviar al ERP");
    expect(orderStatusLabel("synced_to_erp")).toBe("Enviado al ERP");
    expect(orderStatusLabel("error")).toBe("Error");
    expect(orderStatusLabel("raro")).toBe("raro");
  });

  it("entidades de sincronización", () => {
    expect(syncEntityLabel("products")).toBe("Productos");
    expect(syncEntityLabel("customers")).toBe("Clientes");
    expect(syncEntityLabel("heartbeat")).toBe("Latido del agente");
    expect(syncEntityLabel("otra")).toBe("otra");
  });
});

describe("customerAvailableUsd", () => {
  it("límite - deuda, sin negativos ni errores de coma flotante", () => {
    expect(customerAvailableUsd(5000, 1200.5)).toBe(3799.5);
    expect(customerAvailableUsd(0.3, 0.1)).toBe(0.2);
    expect(customerAvailableUsd(1000, 1250)).toBe(0);
  });
});

describe("parseRateInput", () => {
  it("acepta coma o punto decimal y hasta 4 decimales", () => {
    expect(parseRateInput("36,5")).toBe(36.5);
    expect(parseRateInput(" 36.1234 ")).toBe(36.1234);
    expect(parseRateInput("40")).toBe(40);
  });

  it("rechaza vacío, no numérico, cero, negativos, demasiados decimales y exceso", () => {
    for (const bad of [
      "",
      "abc",
      "0",
      "-3",
      "36,12345",
      "1e3",
      "100000000",
      "1.000,50",
      "36,5,2",
    ]) {
      expect(parseRateInput(bad)).toBeNull();
    }
  });
});
