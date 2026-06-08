import type { Project, TaskView } from "@/types"
import { cn } from "@/lib/utils"
import { hueFor } from "@/lib/taskMeta"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Layers, CircleUser, Plus, PanelLeftClose, PanelLeft, FolderClosed } from "lucide-react"

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  username: string
  view: TaskView
  selectedProjectId: number | null
  onSelectView: (view: TaskView) => void
  onSelectProject: (id: number) => void
  projects: Project[]
  counts: { all: number; mine: number }
  onNewProject: () => void
}

export function Sidebar({
  collapsed,
  onToggle,
  username,
  view,
  selectedProjectId,
  onSelectView,
  onSelectProject,
  projects,
  counts,
  onNewProject,
}: SidebarProps) {
  return (
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200"
      style={{ width: collapsed ? 56 : 232 }}
    >
      {/* Workspace header */}
      <div className="flex h-12 items-center gap-2 px-3">
        <div
          className="grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold"
          style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
        >
          K
        </div>
        {!collapsed && (
          <>
            <span className="truncate text-[13px] font-semibold">Kotty Tasks</span>
            <button
              onClick={onToggle}
              className="ml-auto rounded p-1 text-dim hover:bg-accent hover:text-foreground"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </>
        )}
      </div>

      {collapsed && (
        <div className="flex justify-center pb-1">
          <button onClick={onToggle} className="rounded p-1.5 text-dim hover:bg-accent hover:text-foreground" aria-label="Expand sidebar">
            <PanelLeft className="size-4" />
          </button>
        </div>
      )}

      {/* Views */}
      <nav className="flex flex-col gap-0.5 px-2 pt-1">
        <NavItem
          collapsed={collapsed}
          icon={<Layers className="size-4" />}
          label="All tasks"
          count={counts.all}
          active={view === "all" && selectedProjectId === null}
          onClick={() => onSelectView("all")}
        />
        <NavItem
          collapsed={collapsed}
          icon={<CircleUser className="size-4" />}
          label="My tasks"
          count={counts.mine}
          active={view === "mine" && selectedProjectId === null}
          onClick={() => onSelectView("mine")}
        />
      </nav>

      {/* Projects */}
      <div className="mt-4 min-h-0 flex-1 px-2">
        <div className="flex items-center justify-between px-2 pb-1">
          {!collapsed && <span className="text-[11px] font-medium uppercase tracking-wide text-dim">Projects</span>}
          <button
            onClick={onNewProject}
            className={cn("rounded p-1 text-dim hover:bg-accent hover:text-foreground", collapsed && "mx-auto")}
            aria-label="New project"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {projects.map((p) => {
            const color = p.color || `hsl(${hueFor(p.project_key)} 50% 58%)`
            return (
              <NavItem
                key={p.id}
                collapsed={collapsed}
                icon={collapsed ? <FolderClosed className="size-4" /> : <span className="size-2.5 rounded-[3px]" style={{ background: color }} />}
                label={p.name}
                count={p.task_count}
                active={selectedProjectId === p.id}
                onClick={() => onSelectProject(p.id)}
              />
            )
          })}
          {!collapsed && projects.length === 0 && (
            <button onClick={onNewProject} className="rounded-md px-2 py-1.5 text-left text-[13px] text-dim hover:bg-accent hover:text-muted-foreground">
              + New project
            </button>
          )}
        </div>
      </div>

      {/* User footer */}
      <div className="flex h-12 items-center gap-2 border-t border-border px-3">
        <div
          className="grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-medium uppercase"
          style={{ background: `hsl(${hueFor(username)} 26% 22%)`, color: `hsl(${hueFor(username)} 55% 78%)` }}
        >
          {(username || "?").slice(0, 2)}
        </div>
        {!collapsed && <span className="truncate text-[13px] text-muted-foreground">{username}</span>}
      </div>
    </aside>
  )
}

function NavItem({
  collapsed,
  icon,
  label,
  count,
  active,
  onClick,
}: {
  collapsed: boolean
  icon: React.ReactNode
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  const btn = (
    <button
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] outline-none transition-colors",
        active ? "bg-elevated font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        collapsed && "justify-center px-0"
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      {!collapsed && (
        <>
          <span className="truncate">{label}</span>
          {count !== undefined && count > 0 && <span className="ml-auto text-[11px] tabular-nums text-dim">{count}</span>}
        </>
      )}
    </button>
  )
  if (!collapsed) return btn
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
