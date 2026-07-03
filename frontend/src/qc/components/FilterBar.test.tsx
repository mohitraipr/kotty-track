import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FilterBar } from "./FilterBar"
import type { QcFilters } from "@/qc/lib/api"

const defaults: QcFilters = {
  from: "2026-07-01",
  to: "2026-07-01",
  user: "",
  quality: "",
  qc_action: "",
  warehouse: "",
  q: "",
}

function setup(overrides: Partial<QcFilters> = {}) {
  const value = { ...defaults, ...overrides }
  const onApply = vi.fn()
  render(
    <FilterBar
      value={value}
      defaults={defaults}
      csvHref="/qc/api/passes?from=2026-07-01&to=2026-07-01&download=csv"
      onApply={onApply}
    />
  )
  return { onApply }
}

describe("FilterBar", () => {
  it("renders the date range and filter fields", () => {
    setup()
    expect(screen.getByLabelText("From")).toHaveValue("2026-07-01")
    expect(screen.getByLabelText("To")).toHaveValue("2026-07-01")
    expect(screen.getByLabelText("User")).toBeInTheDocument()
    expect(screen.getByLabelText("Quality")).toBeInTheDocument()
    expect(screen.getByLabelText("QC action")).toBeInTheDocument()
    expect(screen.getByLabelText("Warehouse")).toBeInTheDocument()
    expect(screen.getByLabelText("Search")).toBeInTheDocument()
  })

  it("applies edited filters when Apply is clicked", async () => {
    const user = userEvent.setup()
    const { onApply } = setup()

    await user.type(screen.getByLabelText("Search"), "jean")
    await user.type(screen.getByLabelText("User"), "alice")
    await user.click(screen.getByRole("button", { name: /apply/i }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ q: "jean", user: "alice", from: "2026-07-01", to: "2026-07-01" })
    )
  })

  it("resets to the default filters", async () => {
    const user = userEvent.setup()
    const { onApply } = setup({ q: "shirt", user: "bob" })

    await user.click(screen.getByRole("button", { name: /reset/i }))

    expect(onApply).toHaveBeenCalledWith(defaults)
  })

  it("exposes the CSV download link", () => {
    setup()
    const link = screen.getByRole("link", { name: /download csv/i })
    expect(link).toHaveAttribute(
      "href",
      "/qc/api/passes?from=2026-07-01&to=2026-07-01&download=csv"
    )
  })
})
