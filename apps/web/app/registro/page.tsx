import Link from "next/link";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Crear cuenta · ERP Web Bridge" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).empresa;
  const empresa = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Crear cuenta</h1>
        <p className="text-sm text-slate-600">
          Después de crearla, pedirás acceso a tu proveedor y él deberá aprobarlo.
        </p>
      </div>
      <RegisterForm empresa={empresa.slice(0, 60)} />
      <p className="text-sm">
        ¿Ya tienes cuenta?{" "}
        <Link href="/login" className="underline">
          Entrar
        </Link>
      </p>
    </main>
  );
}
