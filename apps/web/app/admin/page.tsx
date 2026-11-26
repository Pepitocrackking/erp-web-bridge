import Link from "next/link";
import { redirect } from "next/navigation";
import {
  fetchCustomers,
  fetchOrders,
  fetchOrgStatus,
  fetchRates,
  fetchSyncLogs,
} from "../../lib/admin";
import { fetchMembership } from "../../lib/catalog";
import { createClient } from "../../lib/supabase/server";
import { signOut } from "../login/actions";
import { AdminDashboard } from "./dashboard";

export const metadata = { title: "Panel · ERP Web Bridge" };

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await fetchMembership(supabase, user.id);
  if (!membership) redirect("/acceso");
  // El panel es del personal de la empresa; los compradores van al catálogo.
  if (membership.role === "customer") redirect("/catalogo");
  const isAdmin = membership.role === "owner" || membership.role === "admin";

  const [org, rates, customers, orders, logs] = await Promise.all([
    fetchOrgStatus(supabase, membership.orgId),
    fetchRates(supabase, membership.orgId),
    fetchCustomers(supabase, membership.orgId),
    fetchOrders(supabase, membership.orgId),
    fetchSyncLogs(supabase, membership.orgId),
  ]);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Panel de administración</h1>
          <p className="text-sm text-slate-600">{membership.orgName}</p>
        </div>
        <nav aria-label="Navegación del panel" className="flex items-center gap-4 text-sm">
          {isAdmin && (
            <Link href="/admin/solicitudes" className="underline">
              Solicitudes de acceso
            </Link>
          )}
          <Link href="/catalogo" className="underline">
            Catálogo
          </Link>
          <form action={signOut}>
            <button className="underline">Salir</button>
          </form>
        </nav>
      </header>
      <AdminDashboard
        orgId={membership.orgId}
        canSetRate={isAdmin}
        initial={{ org, rates, customers, orders, logs }}
      />
    </main>
  );
}
