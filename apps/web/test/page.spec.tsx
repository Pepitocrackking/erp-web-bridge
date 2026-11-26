import { render, screen } from "@testing-library/react";
import Home from "../app/page";

describe("Home", () => {
  it("muestra el título", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "ERP Web Bridge" })).toBeInTheDocument();
  });
});
