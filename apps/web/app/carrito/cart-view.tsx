"use client";

import { formatBs, formatUsd } from "@erp-web-bridge/shared-types";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Quote } from "../../lib/quote";
import type { OrderFailure } from "../../lib/orders";
import { useCart } from "../../lib/use-cart";
import { placeOrder, quoteCart, type PlacedOrder } from "./actions";

export function CartView({ userId, orgName }: { userId: string; orgName: string }) {
  const cart = useCart(userId);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failure, setFailure] = useState<OrderFailure | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const [notes, setNotes] = useState("");
  const [sending, startSending] = useTransition();
  const [hydrated, setHydrated] = useState(false);
  const latest = useRef(0);

  // Las líneas del carrito (SKU y cantidad) se vuelven a cotizar en el servidor cada vez que cambian.
  const signature = JSON.stringify(cart.items);
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (!hydrated || placed) return;
    const ticket = ++latest.current;
    if (cart.items.length === 0) {
      setQuote(null);
      return;
    }
    // Pequeña espera para no cotizar en cada tecla al cambiar una cantidad.
    const timer = window.setTimeout(async () => {
      const result = await quoteCart(cart.items);
      if (ticket !== latest.current) return; // llegó tarde: ya hay una cotización más nueva
      if (result.ok) {
        setQuote(result.quote);
        setLoadError(null);
      } else {
        setLoadError(result.message);
      }
    }, 250);
    return () => window.clearTimeout(timer);
    // `cart.items` cambia de identidad solo cuando cambia el contenido (signature).
  }, [signature, hydrated, placed]);

  if (!hydrated) return <p className="text-slate-600">Cargando carrito…</p>;

  if (placed) {
    return (
      <section
        aria-label="Pedido enviado"
        className="rounded-lg border border-emerald-300 bg-emerald-50 p-6"
      >
        <h2 className="text-xl font-bold text-emerald-900">Pedido recibido</h2>
        <p className="mt-2" data-testid="placed-total">
          Total: {formatUsd(placed.totalUsd)} · {formatBs(placed.totalBs)}
        </p>
        <p className="text-sm text-slate-700">
          Referencia: <span data-testid="placed-id">{placed.id.slice(0, 8)}</span>. {orgName} lo
          recibirá como borrador en su sistema para aprobarlo.
        </p>
        <Link href="/catalogo" className="mt-4 inline-block underline">
          Seguir comprando
        </Link>
      </section>
    );
  }

  if (cart.items.length === 0) {
    return (
      <p className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
        Tu carrito está vacío.{" "}
        <Link href="/catalogo" className="underline">
          Ver el catálogo
        </Link>
      </p>
    );
  }

  const blocked =
    !quote || quote.exceedsCredit || quote.unavailableSkus.length > 0 || quote.lines.length === 0;

  function submit() {
    setFailure(null);
    startSending(async () => {
      const result = await placeOrder(cart.items, notes);
      if (result.ok) {
        cart.clear();
        setPlaced(result.order);
      } else {
        setFailure(result.failure);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {loadError && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {loadError}
        </p>
      )}

      {quote && quote.unavailableSkus.length > 0 && (
        <div role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          <p>Estos productos ya no están disponibles y hay que quitarlos para enviar el pedido:</p>
          <ul className="mt-1 list-inside list-disc">
            {quote.unavailableSkus.map((sku) => (
              <li key={sku}>
                {sku}{" "}
                <button className="underline" onClick={() => cart.remove(sku)}>
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className="w-full text-left text-sm">
        <caption className="sr-only">Productos del carrito</caption>
        <thead>
          <tr className="border-b border-slate-300">
            <th scope="col" className="py-2">
              Producto
            </th>
            <th scope="col">Precio</th>
            <th scope="col">Cantidad</th>
            <th scope="col" className="text-right">
              Subtotal
            </th>
            <th scope="col">
              <span className="sr-only">Quitar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(quote?.lines ?? []).map((line) => (
            <tr
              key={line.sku}
              className="border-b border-slate-200 align-top"
              data-testid={`line-${line.sku}`}
            >
              <td className="py-3">
                <p className="font-medium">{line.name}</p>
                <p className="text-xs text-slate-500">{line.sku}</p>
                {line.stockWarning && <p className="text-xs text-amber-700">{line.stockWarning}</p>}
              </td>
              <td>
                {formatUsd(line.unitUsd)}
                <br />
                <span className="text-xs text-slate-600">{formatBs(line.unitBs)}</span>
              </td>
              <td>
                <input
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={line.quantity}
                  key={`${line.sku}-${line.quantity}`}
                  aria-label={`Cantidad de ${line.name}`}
                  onBlur={(e) => cart.setQty(line.sku, Number(e.target.value))}
                  className="w-20 rounded border border-slate-300 px-2 py-1"
                />
              </td>
              <td className="text-right">
                <span data-testid={`line-usd-${line.sku}`}>{formatUsd(line.lineUsd)}</span>
                <br />
                <span className="text-xs text-slate-600">{formatBs(line.lineBs)}</span>
              </td>
              <td className="pl-2 text-right">
                <button
                  onClick={() => cart.remove(line.sku)}
                  aria-label={`Quitar ${line.name}`}
                  className="text-red-700 underline"
                >
                  Quitar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!quote && !loadError && <p className="text-slate-600">Calculando precios…</p>}

      {quote && (
        <section aria-label="Resumen" className="rounded-lg border border-slate-200 p-4">
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="font-semibold">Total del pedido</dt>
            <dd className="text-right font-semibold" data-testid="total-usd">
              {formatUsd(quote.totalUsd)}
            </dd>
            <dt className="text-slate-600">En bolívares (tasa {formatBs(quote.rateBs)})</dt>
            <dd className="text-right text-slate-600" data-testid="total-bs">
              {formatBs(quote.totalBs)}
            </dd>
            <dt className="mt-2 text-slate-600">Tu crédito disponible</dt>
            <dd className="mt-2 text-right" data-testid="credit-available">
              {formatUsd(quote.credit.availableUsd)}
            </dd>
            <dt className="text-xs text-slate-500">
              Límite {formatUsd(quote.credit.limitUsd)} − deuda {formatUsd(quote.credit.debtUsd)} −
              pedidos en curso {formatUsd(quote.credit.pendingUsd)}
            </dt>
            <dd />
          </dl>
          {quote.exceedsCredit && (
            <p
              role="alert"
              className="mt-3 rounded bg-red-50 p-3 text-sm text-red-800"
              data-testid="over-credit"
            >
              Este pedido supera tu crédito disponible por {formatUsd(quote.overByUsd)}. Reduce
              cantidades o quita productos para poder enviarlo.
            </p>
          )}
        </section>
      )}

      <label className="flex flex-col gap-1 text-sm font-medium">
        Notas para el proveedor (opcional)
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          rows={2}
          className="rounded border border-slate-300 px-3 py-2 font-normal"
        />
      </label>

      {failure && (
        <div
          role="alert"
          className="rounded bg-red-50 p-3 text-sm text-red-800"
          data-testid="order-failure"
        >
          <p className="font-medium">{failure.message}</p>
          {failure.code === "credit_limit_exceeded" && (
            <p>
              Pedido {formatUsd(failure.credit.orderTotalUsd)}; crédito disponible{" "}
              {formatUsd(failure.credit.availableUsd)}.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={submit}
          disabled={blocked || sending}
          className="rounded bg-emerald-700 px-5 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {sending ? "Enviando…" : "Confirmar pedido"}
        </button>
        <button onClick={() => cart.clear()} className="text-sm underline">
          Vaciar carrito
        </button>
        <Link href="/catalogo" className="text-sm underline">
          Seguir comprando
        </Link>
      </div>
    </div>
  );
}
