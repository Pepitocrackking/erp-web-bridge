import { formatBs } from "@erp-web-bridge/shared-types";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  fetchCatalog,
  fetchCategories,
  fetchMembership,
  parseCatalogParams,
  type CatalogParams,
} from "../../lib/catalog";
import { createClient } from "../../lib/supabase/server";
import { signOut } from "../login/actions";
import { ProductCard } from "./product-card";

export const metadata = { title: "Catálogo · ERP Web Bridge" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Enlace del catálogo con los filtros vigentes, cambiando solo lo indicado. */
function href(params: CatalogParams, change: Partial<CatalogParams>): string {
  const next = { ...params, ...change };
  const query = new URLSearchParams();
  if (next.q) query.set("q", next.q);
  if (next.category) query.set("category", next.category);
  if (next.page > 1) query.set("page", String(next.page));
  const text = query.toString();
  return text ? `/catalogo?${text}` : "/catalogo";
}

export default async function CatalogPage({ searchParams }: { searchParams: SearchParams }) {
  const params = parseCatalogParams(await searchParams);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await fetchMembership(supabase, user.id);
  // Sin empresa todavía: pedir acceso (o ver el estado de la solicitud).
  if (!membership) redirect("/acceso");

  const [catalog, categories] = await Promise.all([
    fetchCatalog(supabase, membership, params),
    fetchCategories(supabase, membership.orgId),
  ]);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{membership.orgName}</h1>
          <p className="text-sm text-slate-600" data-testid="rate">
            Tasa del día: {formatBs(membership.rateBs)} por USD
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          {(membership.role === "owner" || membership.role === "admin") && (
            <Link href="/admin/solicitudes" className="underline">
              Solicitudes de acceso
            </Link>
          )}
          <form action={signOut}>
            <button className="underline">Salir</button>
          </form>
        </div>
      </header>

      <form action="/catalogo" method="get" role="search" className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={params.q}
          placeholder="Buscar por nombre o código"
          aria-label="Buscar productos"
          className="min-w-0 flex-1 rounded border border-slate-300 px-3 py-2"
        />
        {params.category && <input type="hidden" name="category" value={params.category} />}
        <button className="rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800">
          Buscar
        </button>
      </form>

      <nav aria-label="Categorías" className="mb-6 flex flex-wrap gap-2">
        <Link
          href={href(params, { category: "", page: 1 })}
          aria-current={params.category === "" ? "page" : undefined}
          className={`rounded-full border px-3 py-1 text-sm ${params.category === "" ? "border-emerald-700 bg-emerald-700 text-white" : "border-slate-300"}`}
        >
          Todas
        </Link>
        {categories.map((c) => (
          <Link
            key={c.category}
            href={href(params, { category: c.category, page: 1 })}
            aria-current={params.category === c.category ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${params.category === c.category ? "border-emerald-700 bg-emerald-700 text-white" : "border-slate-300"}`}
          >
            {c.category} ({c.count})
          </Link>
        ))}
      </nav>

      <p className="mb-4 text-sm text-slate-600" data-testid="result-count">
        {catalog.total === 1 ? "1 producto" : `${catalog.total} productos`}
      </p>

      {catalog.items.length === 0 ? (
        <p className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
          No hay productos que coincidan con la búsqueda.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {catalog.items.map((item) => (
            <li key={item.id}>
              <ProductCard item={item} />
            </li>
          ))}
        </ul>
      )}

      {catalog.pageCount > 1 && (
        <nav
          aria-label="Paginación"
          className="mt-8 flex items-center justify-center gap-4 text-sm"
        >
          {catalog.page > 1 ? (
            <Link href={href(params, { page: catalog.page - 1 })} rel="prev" className="underline">
              ← Anterior
            </Link>
          ) : (
            <span className="text-slate-400">← Anterior</span>
          )}
          <span>
            Página {catalog.page} de {catalog.pageCount}
          </span>
          {catalog.page < catalog.pageCount ? (
            <Link href={href(params, { page: catalog.page + 1 })} rel="next" className="underline">
              Siguiente →
            </Link>
          ) : (
            <span className="text-slate-400">Siguiente →</span>
          )}
        </nav>
      )}
    </main>
  );
}
