import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchMembership } from "../../../lib/catalog";
import { simulatorConfig, type SimRow } from "../../../lib/simulator";
import { createClient } from "../../../lib/supabase/server";
import { signOut } from "../../login/actions";
import { Simulator } from "./simulator";

export const metadata = { title: "Simulador de ERP · ERP Web Bridge" };

const SIMULATOR_ROWS = 300;

export default async function SimulatorPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await fetchMembership(supabase, user.id);
  if (!membership) redirect("/acceso");
  if (membership.role !== "owner" && membership.role !== "admin") redirect("/catalogo");

  const config = simulatorConfig();
  const { data: org } = await supabase
    .from("organizations")
    .select("slug")
    .eq("id", membership.orgId)
    .single();
  const enabled = config !== null && org?.slug === config.orgSlug;

  let rows: SimRow[] = [];
  if (enabled) {
    const { data, error } = await supabase
      .from("products")
      .select("erp_sku, name, category, price_usd, stock, is_active")
      .eq("org_id", membership.orgId)
      .order("erp_sku", { ascending: true })
      .limit(SIMULATOR_ROWS);
    if (error) throw new Error(`No se pudo leer el inventario: ${error.message}`);
    rows = (data ?? []).map((p) => ({
      sku: p.erp_sku,
      name: p.name,
      category: p.category,
      priceUsd: Number(p.price_usd),
      stock: Number(p.stock),
      active: p.is_active,
    }));
  }

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Simulador de ERP</h1>
          <p className="max-w-2xl text-sm text-slate-600">
            Esta tabla emula el inventario de un ERP local (Saint u Odoo). Edita precios o
            existencias y sincroniza: los cambios viajan por la API de ingesta real, como lo haría
            el agente, y el catálogo y el panel se actualizan en vivo.
          </p>
        </div>
        <nav aria-label="Navegación" className="flex items-center gap-4 text-sm">
          <Link href="/admin" className="underline">
            Panel
          </Link>
          <Link href="/catalogo" className="underline">
            Catálogo
          </Link>
          <form action={signOut}>
            <button className="underline">Salir</button>
          </form>
        </nav>
      </header>
      {enabled ? (
        <Simulator initial={rows} />
      ) : (
        <p className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
          El simulador solo está disponible en la organización de demostración.
        </p>
      )}
    </main>
  );
}
