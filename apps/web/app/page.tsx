import Link from "next/link";

export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">ERP Web Bridge</h1>
      <p>Catálogo B2B multimoneda (USD/Bs).</p>
      <p className="mt-4">
        <Link href="/catalogo" className="underline">
          Entrar al catálogo
        </Link>
      </p>
    </main>
  );
}
