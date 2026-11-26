/**
 * Utilidades de dinero: única fuente de la conversión USD -> Bs.
 *
 * Todo precio vive en USD en la base de datos. Los Bs se calculan con la tasa vigente de la
 * organización (`organizations.exchange_rate_bs`, 4 decimales) y se redondean a 2 decimales
 * (mitad hacia arriba). El cálculo es entero (BigInt) para no arrastrar errores de coma flotante.
 */

/** Decimales que se consideran del precio al convertir (el sobrante, p. ej. 0.1+0.2, se descarta). */
const USD_DECIMALS = 8;
/** La tasa tiene 4 decimales en la base (NUMERIC(12,4)). */
const RATE_DECIMALS = 4;
const MAX_USD = 1e12;
const MAX_RATE = 1e9;

/** Convierte un número a entero escalado por 10^decimals (trunca el sobrante), sin pasar por `* 10^n`. */
function toScaled(value: number, decimals: number): bigint {
  let text = String(value);
  if (/e/i.test(text)) text = value.toFixed(decimals + 4);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0").slice(0, decimals));
}

/**
 * Convierte USD a Bs con la tasa dada, redondeando a 2 decimales (mitad hacia arriba).
 * Lanza RangeError si el precio es negativo o no finito, o si la tasa no es positiva y finita.
 */
export function usdToBs(usd: number, rateBs: number): number {
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
    throw new RangeError(`Precio USD no válido: ${usd}`);
  }
  if (!Number.isFinite(rateBs) || rateBs <= 0 || rateBs > MAX_RATE) {
    throw new RangeError(`Tasa de cambio no válida: ${rateBs}`);
  }
  // usd * 10^8 por tasa * 10^4 = Bs * 10^12. Para centavos de Bs: dividir entre 10^10.
  const product = toScaled(usd, USD_DECIMALS) * toScaled(rateBs, RATE_DECIMALS);
  const divisor = 10n ** BigInt(USD_DECIMALS + RATE_DECIMALS - 2);
  const cents = (product + divisor / 2n) / divisor;
  return Number(cents) / 100;
}

/** Agrupa miles con punto y usa coma decimal (formato venezolano), sin depender del ICU del entorno. */
function formatNumber(value: number): string {
  const [whole = "0", fraction = "00"] = Math.abs(value).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}${grouped},${fraction}`;
}

/** `$ 1.234,50` */
export function formatUsd(usd: number): string {
  return `$ ${formatNumber(usd)}`;
}

/** `Bs. 1.234,50` */
export function formatBs(bs: number): string {
  return `Bs. ${formatNumber(bs)}`;
}

/** Centavos enteros de un importe en USD (con 2 decimales). */
function toCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
    throw new RangeError(`Importe USD no válido: ${usd}`);
  }
  return Math.round(usd * 100);
}

/** Total de una línea de pedido: precio unitario por cantidad entera, calculado en centavos. */
export function lineTotalUsd(unitUsd: number, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Cantidad no válida: ${quantity}`);
  }
  return (toCents(unitUsd) * quantity) / 100;
}

/** Suma de importes en USD, en centavos enteros (sin acumular errores de coma flotante). */
export function sumUsd(values: number[]): number {
  return values.reduce((cents, v) => cents + toCents(v), 0) / 100;
}
