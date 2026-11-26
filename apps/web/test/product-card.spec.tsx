import { render, screen } from "@testing-library/react";
import { ProductCard } from "../app/catalogo/product-card";
import type { CatalogItem } from "../lib/catalog";

const item: CatalogItem = {
  id: "p1",
  sku: "P00001",
  name: "Harina de maíz 1 kg",
  description: null,
  category: "Alimentos",
  imageUrl: null,
  priceUsd: 1234.5,
  priceBs: 45062.25,
  stock: { text: "Quedan 4", level: "low" },
};

describe("ProductCard", () => {
  it("muestra el precio en USD y en Bs con formato venezolano", () => {
    render(<ProductCard item={item} />);
    expect(screen.getByTestId("price-usd")).toHaveTextContent("$ 1.234,50");
    expect(screen.getByTestId("price-bs")).toHaveTextContent("Bs. 45.062,25");
  });

  it("muestra nombre, código, categoría y existencia", () => {
    render(<ProductCard item={item} />);
    expect(screen.getByRole("heading", { name: "Harina de maíz 1 kg" })).toBeInTheDocument();
    expect(screen.getByText("P00001 · Alimentos")).toBeInTheDocument();
    expect(screen.getByText("Quedan 4")).toBeInTheDocument();
  });

  it("con imagen la muestra con texto alternativo; sin imagen, un marcador", () => {
    const { rerender } = render(<ProductCard item={item} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    rerender(<ProductCard item={{ ...item, imageUrl: "https://example.com/a.jpg" }} />);
    expect(screen.getByRole("img", { name: "Harina de maíz 1 kg" })).toHaveAttribute(
      "src",
      "https://example.com/a.jpg",
    );
  });
});
