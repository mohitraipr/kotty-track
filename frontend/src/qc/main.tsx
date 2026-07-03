import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"

const el = document.getElementById("qc-root")
if (el) {
  const meId = Number(el.dataset.userId)
  const role = el.dataset.userRole || ""
  const username = el.dataset.username || "user"
  createRoot(el).render(
    <StrictMode>
      <App meId={meId} role={role} username={username} />
    </StrictMode>
  )
}
