/** URL de la API para el servidor de Next (no se expone al navegador; así no hace falta CORS). */
export function apiUrl(): string {
  return (
    process.env.API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  ).replace(/\/+$/, "");
}
