import { describe, it, expect } from "vitest"
import { passesQueryString, passesUrl } from "./api"

describe("passesQueryString", () => {
  it("omits blank and whitespace-only filters", () => {
    expect(passesQueryString({})).toBe("")
    expect(passesQueryString({ user: "", q: "   " })).toBe("")
  })

  it("includes and trims non-empty filters in a stable order", () => {
    const qs = passesQueryString({
      from: "2026-06-01",
      to: "2026-06-30",
      user: "  alice  ",
      q: "jean",
    })
    expect(qs).toBe("from=2026-06-01&to=2026-06-30&user=alice&q=jean")
  })

  it("url-encodes special characters", () => {
    expect(passesQueryString({ q: "a&b c" })).toBe("q=a%26b+c")
  })

  it("appends extras like download=csv last", () => {
    expect(passesQueryString({ from: "2026-06-01" }, { download: "csv" })).toBe(
      "from=2026-06-01&download=csv"
    )
  })
})

describe("passesUrl", () => {
  it("returns a bare path when there are no params", () => {
    expect(passesUrl({})).toBe("/qc/api/passes")
  })

  it("builds a full CSV download URL", () => {
    expect(passesUrl({ from: "2026-06-01", to: "2026-06-01" }, { download: "csv" })).toBe(
      "/qc/api/passes?from=2026-06-01&to=2026-06-01&download=csv"
    )
  })
})
