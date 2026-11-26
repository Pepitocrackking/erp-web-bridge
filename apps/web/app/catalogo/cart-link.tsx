"use client";

import Link from "next/link";
import { useCart } from "../../lib/use-cart";

export function CartLink({ userId }: { userId: string }) {
  const { items } = useCart(userId);
  return (
    <Link href="/carrito" className="underline">
      Carrito <span data-testid="cart-count">({items.length})</span>
    </Link>
  );
}
