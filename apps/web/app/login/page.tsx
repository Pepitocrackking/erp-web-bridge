import Link from "next/link";
import { isDemoMode } from "../../lib/demo";
import { signInDemo } from "./actions";
import { LoginForm } from "./login-form";

export const metadata = { title: "Entrar · ERP Web Bridge" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const demo = isDemoMode();
  const demoFailed = (await searchParams).demo === "error";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Entrar</h1>
        <p className="text-sm text-slate-600">Accede al catálogo de tu proveedor.</p>
      </div>
      <LoginForm />
      <p className="text-sm">
        ¿Eres cliente y aún no tienes cuenta?{" "}
        <Link href="/registro" className="underline">
          Crear cuenta
        </Link>
      </p>
      {demo && (
        <section
          aria-label="Modo demo"
          className="rounded-lg border border-dashed border-slate-300 p-4"
        >
          <p className="mb-3 text-sm text-slate-600">
            ¿Solo quieres ver cómo funciona? Entra sin registrarte a un panel de ejemplo.
          </p>
          <form action={signInDemo}>
            <button className="w-full rounded border border-emerald-700 px-4 py-2 font-medium text-emerald-800 hover:bg-emerald-50">
              Entrar como Administrador Demo
            </button>
          </form>
          {demoFailed && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              No se pudo entrar al modo demo. Inténtalo de nuevo.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
