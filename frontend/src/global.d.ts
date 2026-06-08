// The host EJS page exposes a global toast helper (views/partials/footer.ejs).
export {}

declare global {
  interface Window {
    KottyTrack?: {
      showToast?: (message: string, type?: "success" | "danger" | "info" | "warning") => void
    }
  }
}
