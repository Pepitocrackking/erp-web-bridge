import { redirect } from "next/navigation";
import { fetchMyRequests } from "../../lib/access";
import { fetchMembership } from "../../lib/catalog";
import { createClient } from "../../lib/supabase/server";
import { AccessForm } from "./access-form";
import { SignOutButton } from "../sign-out-button";

export const metadata = { title: "Solicitar acceso · ERP Web Bridge" };

const STATUS = {
  pending: { label: "Pendiente de aprobación", style: "bg-amber-100 text-amber-800" },
  approved: { label: "Aprobada", style: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "Rechazada", style: "bg-red-100 text-red-800" },
} as const;

export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (await fetchMembership(supabase, user.id)) redirect("/catalogo");

  const raw = (await searchParams).empresa;
  const empresa = ((Array.isArray(raw) ? raw[0] : raw) ?? "").slice(0, 60);
  const requests = await fetchMyRequests(supabase, user.id);

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Acceso al catálogo</h1>
          <p className="text-sm text-slate-600">Sesión: {user.email}</p>
        </div>
        <SignOutButton className="text-sm underline" />
      </header>

      {requests.length > 0 && (
        <section aria-label="Tus solicitudes" className="flex flex-col gap-3">
          <h2 className="font-semibold">Tus solicitudes</h2>
          <ul className="flex flex-col gap-2">
            {requests.map((r) => (
              <li key={r.id} className="rounded border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{r.orgName}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[r.status].style}`}
                  >
                    {STATUS[r.status].label}
                  </span>
                </div>
                <p className="text-slate-600">RIF: {r.taxId}</p>
                {r.status === "pending" && (
                  <p className="text-slate-600">
                    El administrador de {r.orgName} debe aprobarla. Vuelve más tarde.
                  </p>
                )}
                {r.status === "rejected" && (
                  <p className="text-red-700">
                    {r.decisionNote ? `Motivo: ${r.decisionNote}. ` : ""}Puedes corregir los datos y
                    pedirla de nuevo.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Solicitar acceso" className="flex flex-col gap-3">
        <h2 className="font-semibold">
          {requests.length > 0 ? "Pedir acceso de nuevo o a otra empresa" : "Solicitar acceso"}
        </h2>
        <AccessForm empresa={empresa} />
      </section>
    </main>
  );
}
