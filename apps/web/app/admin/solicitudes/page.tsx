import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchActiveCustomers, fetchPendingRequests, suggestCustomer } from "../../../lib/access";
import { fetchMembership } from "../../../lib/catalog";
import { createClient } from "../../../lib/supabase/server";
import { signOut } from "../../login/actions";
import { approveRequest, rejectRequest } from "./actions";

export const metadata = { title: "Solicitudes de acceso · ERP Web Bridge" };

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await fetchMembership(supabase, user.id);
  if (!membership) redirect("/acceso");
  if (membership.role !== "owner" && membership.role !== "admin") redirect("/catalogo");

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const ok = one(params.ok);
  const error = one(params.error);
  const errorId = one(params.id);

  const [requests, customers] = await Promise.all([
    fetchPendingRequests(supabase, membership.orgId),
    fetchActiveCustomers(supabase, membership.orgId),
  ]);

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Solicitudes de acceso</h1>
          <p className="text-sm text-slate-600">{membership.orgName}</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/catalogo" className="underline">
            Ir al catálogo
          </Link>
          <form action={signOut}>
            <button className="underline">Salir</button>
          </form>
        </div>
      </header>

      {ok && (
        <p role="status" className="mb-4 rounded bg-emerald-50 p-3 text-sm text-emerald-800">
          {ok}
        </p>
      )}

      {requests.length === 0 ? (
        <p className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
          No hay solicitudes pendientes.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {requests.map((r) => {
            const suggested = suggestCustomer(r.taxId, customers);
            return (
              <li
                key={r.id}
                aria-label={r.email}
                className="rounded-lg border border-slate-200 p-4"
              >
                <div className="mb-3">
                  <p className="font-medium">{r.email}</p>
                  <p className="text-sm text-slate-600">
                    RIF: {r.taxId}
                    {r.businessName ? ` · ${r.businessName}` : ""}
                  </p>
                  {suggested === null && (
                    <p className="text-sm text-amber-700">
                      Ningún cliente tiene este RIF (o hay varios): elige el cliente.
                    </p>
                  )}
                </div>
                {error && errorId === r.id && (
                  <p role="alert" className="mb-3 text-sm text-red-700">
                    {error}
                  </p>
                )}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <form action={approveRequest} className="flex flex-1 flex-wrap items-end gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
                      Cliente del ERP
                      <select
                        name="customerId"
                        defaultValue={suggested ?? ""}
                        className="rounded border border-slate-300 px-2 py-2 font-normal"
                      >
                        <option value="">Por RIF (automático)</option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} · {c.name} · {c.taxId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
                      Aprobar
                    </button>
                  </form>
                  <form action={rejectRequest} className="flex items-end gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <label className="flex flex-col gap-1 text-sm font-medium">
                      Motivo (opcional)
                      <input
                        name="note"
                        maxLength={500}
                        className="rounded border border-slate-300 px-2 py-2 font-normal"
                      />
                    </label>
                    <button className="rounded border border-red-700 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
                      Rechazar
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
