"use client";

import { useState } from "react";
import { useCart } from "../../lib/use-cart";

export function AddToCart({
  userId,
  sku,
  name,
  disabled,
}: {
  userId: string;
  sku: string;
  name: string;
  disabled?: boolean;
}) {
  const cart = useCart(userId);
  const [quantity, setQuantity] = useState("1");
  const [added, setAdded] = useState(false);

  const parsed = Number(quantity);
  const valid = Number.isInteger(parsed) && parsed >= 1;

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || disabled) return;
        cart.add(sku, parsed);
        setAdded(true);
        window.setTimeout(() => setAdded(false), 1500);
      }}
    >
      <input
        type="number"
        min={1}
        step={1}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        aria-label={`Cantidad de ${name}`}
        disabled={disabled}
        className="w-20 rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={disabled || !valid}
        aria-label={`Agregar ${name} al carrito`}
        className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
      >
        Agregar
      </button>
      <span role="status" className="text-xs text-emerald-800">
        {added ? "Agregado" : ""}
      </span>
    </form>
  );
}
