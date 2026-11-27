import { redirect } from "next/navigation";
import {
  fetchCustomers,
  fetchOrders,
  fetchOrgStatus,
  fetchRates,
  fetchSyncLogs,
} from "../../lib/admin";
import { fetchMembership } from "../../lib/catalog";
import { simulatorConfig } from "../../lib/simulator";
import { createClient } from "../../lib/supabase/server";
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

  const config = simulatorConfig();
  const { data: slugRow } =
    isAdmin && config
      ? await supabase.from("organizations").select("slug").eq("id", membership.orgId).single()
      : { data: null };
  const showSimulator = config !== null && slugRow?.slug === config.orgSlug;

  const [org, rates, customers, orders, logs] = await Promise.all([
    fetchOrgStatus(supabase, membership.orgId),
    fetchRates(supabase, membership.orgId),
    fetchCustomers(supabase, membership.orgId),
    fetchOrders(supabase, membership.orgId),
    fetchSyncLogs(supabase, membership.orgId),
  ]);

  // La cabecera vive en el componente cliente: lleva el contador de alertas, que se actualiza en vivo.
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <AdminDashboard
        orgId={membership.orgId}
        orgName={membership.orgName}
        canSetRate={isAdmin}
        showSimulator={showSimulator}
        initial={{ org, rates, customers, orders, logs }}
      />
    </main>
  );
}
