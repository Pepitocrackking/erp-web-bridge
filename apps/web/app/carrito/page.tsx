import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchMembership } from "../../lib/catalog";
import { createClient } from "../../lib/supabase/server";
import { signOut } from "../login/actions";
import { CartView } from "./cart-view";

export const metadata = { title: "Carrito · ERP Web Bridge" };

export default async function CartPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await fetchMembership(supabase, user.id);
  if (!membership) redirect("/acceso");
  // Solo los compradores hacen pedidos; el personal no tiene carrito.
  if (membership.role !== "customer") redirect("/catalogo");

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Tu carrito</h1>
          <p className="text-sm text-slate-600">{membership.orgName}</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/catalogo" className="underline">
            Catálogo
          </Link>
          <form action={signOut}>
            <button className="underline">Salir</button>
          </form>
        </div>
      </header>
      <CartView userId={user.id} orgName={membership.orgName} />
    </main>
  );
}
