"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  addItem,
  cartKey,
  parseCart,
  removeItem,
  serializeCart,
  setQuantity,
  type CartItem,
} from "./cart";

const CHANGE_EVENT = "erpwb:cart-change";

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback); // otras pestañas
  window.addEventListener(CHANGE_EVENT, callback); // esta pestaña
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/**
 * Carrito del usuario guardado en localStorage y compartido entre componentes y pestañas.
 * El snapshot es el texto crudo (estable mientras no cambie); el parseo se memoriza aparte.
 */
export function useCart(userId: string) {
  const key = cartKey(userId);
  const raw = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(key) ?? "",
    () => "", // en el servidor no hay carrito
  );
  const items = useMemo(() => parseCart(raw), [raw]);

  const update = useCallback(
    (change: (current: CartItem[]) => CartItem[]) => {
      const current = parseCart(window.localStorage.getItem(key));
      window.localStorage.setItem(key, serializeCart(change(current)));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [key],
  );

  return {
    items,
    add: (sku: string, quantity: number) => update((c) => addItem(c, sku, quantity)),
    setQty: (sku: string, quantity: number) => update((c) => setQuantity(c, sku, quantity)),
    remove: (sku: string) => update((c) => removeItem(c, sku)),
    clear: () => update(() => []),
  };
}
