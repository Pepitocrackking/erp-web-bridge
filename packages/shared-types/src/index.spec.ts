import { healthSchema } from "./index";

describe("healthSchema", () => {
  it("acepta status ok", () => {
    expect(healthSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rechaza otros estados", () => {
    expect(healthSchema.safeParse({ status: "down" }).success).toBe(false);
  });
});
