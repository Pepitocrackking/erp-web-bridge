import { EXCHANGE_RATE_MAX } from "@erp-web-bridge/shared-types";

/** Una lectura de tasa (Bs por USD) de una fuente externa. */
export interface SourceRate {
  rate: number;
  /** Fuente que la entregó: 'bcv.org.ve' o 'dolarapi'. */
  provider: string;
  /** Fecha valor que declara la fuente (ISO), si la declara. */
  valueDate: string | null;
}

/** Fallo de una fuente: no responde, cambió de formato o entregó un valor imposible. */
export class RateSourceError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "RateSourceError";
  }
}

export interface RateSource {
  readonly provider: string;
  fetchRate(): Promise<SourceRate>;
}

/**
 * Convierte un número escrito a la venezolana ("1.016,86449384" o "926,3592") en number.
 * Devuelve null si no tiene la forma esperada.
 */
export function parseVeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(text)) return null;
  const n = Number(text.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Rango sensato de una tasa Bs/USD: fuera de él es un error de lectura, no una tasa. */
export function isPlausibleRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0 && rate <= EXCHANGE_RATE_MAX;
}

/**
 * Extrae la tasa del dólar del HTML de la portada de bcv.org.ve. Busca el bloque `id="dolar"`
 * (la página trae también euro, yuan, lira y rublo: tomar el primer `<strong>` daría el euro) y,
 * dentro de él, el primer `<strong>`. Si el bloque falta o el número no tiene la forma esperada,
 * falla en lugar de adivinar: así un cambio en la página se nota en vez de publicar una tasa errónea.
 */
export function parseBcvHtml(html: string): { rate: number; valueDate: string | null } {
  const start = html.search(/<div[^>]*\bid=["']dolar["'][^>]*>/i);
  if (start < 0) throw new RateSourceError("bcv.org.ve", "no se encontró el bloque del dólar");
  // El bloque llega hasta el siguiente <div id="..."> de otra moneda, o 1500 caracteres como tope.
  const rest = html.slice(start + 1);
  const next = rest.search(/<div[^>]*\bid=["'][a-z]+["'][^>]*>/i);
  const block = rest.slice(0, next >= 0 ? Math.min(next, 1500) : 1500);
  const strong = /<strong[^>]*>([^<]*)<\/strong>/i.exec(block);
  if (!strong) throw new RateSourceError("bcv.org.ve", "el bloque del dólar no trae una cifra");
  const rate = parseVeNumber(strong[1] ?? "");
  if (rate === null || !isPlausibleRate(rate)) {
    throw new RateSourceError("bcv.org.ve", `cifra ilegible: ${JSON.stringify(strong[1])}`);
  }
  const date = /Fecha Valor:[\s\S]{0,200}?content=["']([^"']+)["']/i.exec(html);
  return { rate, valueDate: date?.[1] ?? null };
}

/** Respuesta de DolarAPI (https://ve.dolarapi.com/v1/dolares/oficial). */
export function parseDolarApi(body: unknown): { rate: number; valueDate: string | null } {
  const doc = body as { promedio?: unknown; venta?: unknown; fechaActualizacion?: unknown } | null;
  const raw = doc?.promedio ?? doc?.venta;
  if (typeof raw !== "number" || !isPlausibleRate(raw)) {
    throw new RateSourceError("dolarapi", "la respuesta no trae una tasa válida");
  }
  const date = typeof doc?.fechaActualizacion === "string" ? doc.fechaActualizacion : null;
  return { rate: raw, valueDate: date };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function getText(
  provider: string,
  url: string,
  timeoutMs: number,
  fetchFn: FetchLike,
): Promise<{ text: string }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; erp-web-bridge)", accept: "*/*" },
      redirect: "manual", // una redirección no se sigue hacia otro destino
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new RateSourceError(provider, `no se pudo conectar (${(err as Error).message})`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new RateSourceError(provider, `respondió HTTP ${res.status}`);
  }
  // Tope de tamaño: la portada pesa ~160 KB; un cuerpo enorme no es la portada.
  const text = await res.text();
  if (text.length > 2_000_000) throw new RateSourceError(provider, "respuesta demasiado grande");
  return { text };
}

export class BcvSource implements RateSource {
  readonly provider = "bcv.org.ve";
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async fetchRate(): Promise<SourceRate> {
    const { text } = await getText(this.provider, this.url, this.timeoutMs, this.fetchFn);
    return { provider: this.provider, ...parseBcvHtml(text) };
  }
}

export class DolarApiSource implements RateSource {
  readonly provider = "dolarapi";
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async fetchRate(): Promise<SourceRate> {
    const { text } = await getText(this.provider, this.url, this.timeoutMs, this.fetchFn);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RateSourceError(this.provider, "la respuesta no es JSON");
    }
    return { provider: this.provider, ...parseDolarApi(body) };
  }
}
