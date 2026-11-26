import { formatBs, formatUsd } from "@erp-web-bridge/shared-types";
import type { CatalogItem } from "../../lib/catalog";

const STOCK_STYLES = {
  ok: "bg-emerald-100 text-emerald-800",
  low: "bg-amber-100 text-amber-800",
  out: "bg-slate-200 text-slate-600",
} as const;

export function ProductCard({ item }: { item: CatalogItem }) {
  return (
    <article
      aria-label={item.name}
      className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
    >
      <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-slate-400">
        {item.imageUrl ? (
          // Las imágenes son URLs externas que gestiona el panel: <img> evita configurar dominios.
          <img
            src={item.imageUrl}
            alt={item.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span aria-hidden="true" className="text-sm">
            Sin imagen
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="text-xs text-slate-500">
          {item.sku}
          {item.category ? ` · ${item.category}` : ""}
        </p>
        <h3 className="font-medium leading-snug">{item.name}</h3>
        {item.description && <p className="text-sm text-slate-600">{item.description}</p>}
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <div>
            <p className="text-lg font-semibold" data-testid="price-usd">
              {formatUsd(item.priceUsd)}
            </p>
            <p className="text-sm text-slate-600" data-testid="price-bs">
              {formatBs(item.priceBs)}
            </p>
          </div>
          <span
            className={`rounded px-2 py-1 text-xs font-medium ${STOCK_STYLES[item.stock.level]}`}
          >
            {item.stock.text}
          </span>
        </div>
      </div>
    </article>
  );
}
