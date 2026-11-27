import { isPlausibleRate, RateSourceError, type RateSource, type SourceRate } from "./rate-sources";

/** Las dos fuentes (o la única) fallaron: el llamador conserva la última tasa y avisa. */
export class AllSourcesFailedError extends Error {
  constructor(readonly failures: { provider: string; error: string }[]) {
    super(`Ninguna fuente de tasa respondió: ${failures.map((f) => f.error).join("; ")}`);
    this.name = "AllSourcesFailedError";
  }
}

export interface RateLookup extends SourceRate {
  /** Fuentes que fallaron antes de llegar a la que respondió (vacío si la primaria respondió). */
  failures: { provider: string; error: string }[];
}

/** Prueba las fuentes en orden y devuelve la primera lectura válida. */
export async function lookupRate(sources: RateSource[]): Promise<RateLookup> {
  const failures: { provider: string; error: string }[] = [];
  for (const source of sources) {
    try {
      const got = await source.fetchRate();
      if (!isPlausibleRate(got.rate)) {
        throw new RateSourceError(source.provider, `tasa fuera de rango: ${got.rate}`);
      }
      return { ...got, failures };
    } catch (err) {
      failures.push({ provider: source.provider, error: (err as Error).message });
    }
  }
  throw new AllSourcesFailedError(failures);
}

export interface JumpCheck {
  ok: boolean;
  /** Variación porcentual respecto de la tasa anterior (null si no hay anterior). */
  changePercent: number | null;
}

/**
 * Descarta un salto brusco. Con una tasa anterior, una variación mayor a `maxJumpPercent` se
 * considera una lectura errónea (HTML cambiado, cifra mal leída) y no se aplica. Sin tasa
 * anterior, o con la tasa de arranque 1.0 que traen las organizaciones nuevas, se acepta.
 */
export function checkJump(
  previous: number | null,
  next: number,
  maxJumpPercent: number,
): JumpCheck {
  if (previous === null || previous <= 1) return { ok: true, changePercent: null };
  const changePercent = ((next - previous) / previous) * 100;
  return { ok: Math.abs(changePercent) <= maxJumpPercent, changePercent };
}
