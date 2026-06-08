import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"

const el = document.getElementById("tasks-root")
if (el) {
  const meId = Number(el.dataset.userId)
  const isAdmin = el.dataset.userRole === "admin"
  createRoot(el).render(
    <StrictMode>
      <App meId={meId} isAdmin={isAdmin} />
    </StrictMode>
  )
}
