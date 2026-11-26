import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata = { title: "Entrar · ERP Web Bridge" };

export default function LoginPage() {
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
    </main>
  );
}
