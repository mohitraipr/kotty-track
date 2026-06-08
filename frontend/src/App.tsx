import * as React from "react"
import type { Task, Project, AssignableUser, TaskView, TaskStatus, TaskPriority } from "@/types"
import { api, type TaskInput } from "@/lib/api"
import { classify } from "@/lib/caps"
import { toast, Toaster } from "@/lib/toast"
import {
  SECTION_ORDER,
  PRIORITY_ORDER,
  STATUS_META,
  PRIORITY_META,
  BOARD_STATUSES,
  StatusIcon,
  PriorityIcon,
} from "@/lib/taskMeta"
import { Sidebar } from "@/components/Sidebar"
import { TaskListView } from "@/components/TaskListView"
import { TaskFormDialog } from "@/components/TaskFormDialog"
import { NewProjectDialog } from "@/components/NewProjectDialog"
import { CommandPalette } from "@/components/CommandPalette"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Search, SlidersHorizontal, Plus, X, KanbanSquare, List as ListIcon } from "lucide-react"

interface AppProps {
  meId: number
  isAdmin: boolean
  username: string
}

type FormState = { open: false } | { open: true; mode: "create" | "edit"; task: Task | null }

export default function App({ meId, isAdmin, username }: AppProps) {
  const [allTasks, setAllTasks] = React.useState<Task[]>([])
  const [projects, setProjects] = React.useState<Project[]>([])
  const [users, setUsers] = React.useState<AssignableUser[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [collapsed, setCollapsed] = React.useState(false)
  const [view, setView] = React.useState<TaskView>("all")
  const [projectId, setProjectId] = React.useState<number | null>(null)
  const [tab, setTab] = React.useState<"list" | "board">("list")

  const [search, setSearch] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<Set<TaskStatus>>(new Set())
  const [priorityFilter, setPriorityFilter] = React.useState<Set<TaskPriority>>(new Set())

  const [selectedId, setSelectedId] = React.useState<number | null>(null)
  const [form, setForm] = React.useState<FormState>({ open: false })
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  const [cmdkOpen, setCmdkOpen] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const reload = React.useCallback(async () => {
    try {
      const { tasks } = await api.list("all")
      setAllTasks(tasks)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void reload()
    api.projects().then((r) => setProjects(r.projects)).catch(() => {})
    api.users().then((r) => setUsers(r.users)).catch(() => {})
  }, [reload])

  // Derived, instant view switching — no refetch.
  const visibleTasks = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = allTasks.filter((t) => {
      if (view === "mine" && t.assigned_to !== meId) return false
      if (projectId && t.project_id !== projectId) return false
      if (statusFilter.size && !statusFilter.has(t.status)) return false
      if (priorityFilter.size && !priorityFilter.has(t.priority)) return false
      if (q) {
        const hay = `${t.title} ${t.tags.join(" ")} ${t.assigned_to_username} ${t.project_key || ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return list.sort((a, b) => {
      const s = SECTION_ORDER.indexOf(a.status) - SECTION_ORDER.indexOf(b.status)
      if (s) return s
      const p = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
      if (p) return p
      const ad = a.due_date ? Date.parse(a.due_date) : Infinity
      const bd = b.due_date ? Date.parse(b.due_date) : Infinity
      if (ad !== bd) return ad - bd
      return b.id - a.id
    })
  }, [allTasks, view, projectId, statusFilter, priorityFilter, search, meId])

  const counts = React.useMemo(
    () => ({ all: allTasks.length, mine: allTasks.filter((t) => t.assigned_to === meId).length }),
    [allTasks, meId]
  )
  const projectsWithCounts = React.useMemo(
    () => projects.map((p) => ({ ...p, task_count: allTasks.filter((t) => t.project_id === p.id).length })),
    [projects, allTasks]
  )

  const activeProject = projectId ? projects.find((p) => p.id === projectId) : null
  const titleText = activeProject ? activeProject.name : view === "mine" ? "My tasks" : "All tasks"
  const filterCount = statusFilter.size + priorityFilter.size

  // ----- actions -----
  const selectView = (v: TaskView) => { setView(v); setProjectId(null) }
  const selectProject = (id: number) => { setProjectId(id); setView("all") }

  async function handleSetStatus(task: Task, s: TaskStatus) {
    try {
      const { task: updated } = await api.setStatus(task.id, s)
      setAllTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)))
      toast(`Moved to ${STATUS_META[s].label}`, "success")
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update status.", "error")
    }
  }

  async function handleDelete(task: Task) {
    if (!window.confirm(`Delete "${task.title}"?`)) return
    try {
      await api.remove(task.id)
      setAllTasks((prev) => prev.filter((t) => t.id !== task.id))
      toast("Task deleted", "info")
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete.", "error")
    }
  }

  async function handleSubmit(input: TaskInput) {
    if (form.open && form.mode === "edit" && form.task) {
      const base = form.task
      const caps = classify(base, meId, isAdmin)
      if (caps.canEditFields) {
        const fields: Partial<TaskInput> = {}
        if (input.title !== base.title) fields.title = input.title
        if ((input.description || "") !== (base.description || "")) fields.description = input.description
        if (input.priority !== base.priority) fields.priority = input.priority
        if ((input.due_date || null) !== (base.due_date || null)) fields.due_date = input.due_date
        if ((input.project_id ?? null) !== (base.project_id ?? null)) fields.project_id = input.project_id
        if (JSON.stringify(input.tags) !== JSON.stringify(base.tags)) fields.tags = input.tags
        if (Object.keys(fields).length) await api.update(base.id, fields)
      }
      if (input.status && input.status !== base.status && caps.canSetStatus) await api.setStatus(base.id, input.status)
      if (input.assigned_to && input.assigned_to !== base.assigned_to && caps.canReassign) await api.assign(base.id, input.assigned_to)
      toast("Saved", "success")
    } else {
      await api.create(input)
      toast("Task created", "success")
    }
    await reload()
  }

  async function handleCreateProject(name: string, key: string) {
    const { project } = await api.createProject(name, key)
    setProjects((prev) => [...prev, project].sort((a, b) => a.name.localeCompare(b.name)))
    toast("Project created", "success")
  }

  const openTask = (t: Task) => setForm({ open: true, mode: "edit", task: t })
  const newTask = () => setForm({ open: true, mode: "create", task: null })

  // ----- keyboard -----
  const moveSelection = React.useCallback(
    (dir: 1 | -1) => {
      if (!visibleTasks.length) return
      const idx = visibleTasks.findIndex((t) => t.id === selectedId)
      const next = idx < 0 ? (dir === 1 ? 0 : visibleTasks.length - 1) : Math.min(visibleTasks.length - 1, Math.max(0, idx + dir))
      const id = visibleTasks[next].id
      setSelectedId(id)
      requestAnimationFrame(() =>
        document.querySelector(`[data-task-row="${id}"]`)?.scrollIntoView({ block: "nearest" })
      )
    },
    [visibleTasks, selectedId]
  )

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdkOpen((v) => !v); return }

      const el = e.target as HTMLElement
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      const dialogOpen = form.open || newProjectOpen || cmdkOpen
      if (e.key === "Escape" && !dialogOpen) { setSelectedId(null); ;(document.activeElement as HTMLElement)?.blur?.() }
      if (typing || dialogOpen) return

      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveSelection(1) }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1) }
      else if (e.key === "Enter") {
        const t = visibleTasks.find((x) => x.id === selectedId)
        if (t) openTask(t)
      } else if (e.key === "c") { e.preventDefault(); newTask() }
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [moveSelection, visibleTasks, selectedId, form.open, newProjectOpen, cmdkOpen])

  const toggleSet = <T,>(set: Set<T>, val: T, setter: (s: Set<T>) => void) => {
    const next = new Set(set)
    next.has(val) ? next.delete(val) : next.add(val)
    setter(next)
  }

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={500}>
      <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          username={username}
          view={view}
          selectedProjectId={projectId}
          onSelectView={selectView}
          onSelectProject={selectProject}
          projects={projectsWithCounts}
          counts={counts}
          onNewProject={() => setNewProjectOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
            <div className="flex min-w-0 items-center gap-2">
              {activeProject && (
                <span className="size-2.5 rounded-[3px]" style={{ background: activeProject.color || "var(--primary)" }} />
              )}
              <h1 className="truncate text-[14px] font-semibold">{titleText}</h1>
              <span className="text-[12px] tabular-nums text-dim">{visibleTasks.length}</span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="relative hidden sm:block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="h-8 w-44 rounded-md border border-border bg-elevated pl-8 pr-2 text-[13px] outline-none transition-colors placeholder:text-dim focus:border-border-strong focus:w-56"
                />
              </div>

              {/* Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated px-2.5 text-[13px] text-muted-foreground hover:text-foreground">
                    <SlidersHorizontal className="size-3.5" />
                    Filter
                    {filterCount > 0 && (
                      <span className="rounded bg-primary/20 px-1 text-[11px] text-primary">{filterCount}</span>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>Status</DropdownMenuLabel>
                  {BOARD_STATUSES.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s}
                      checked={statusFilter.has(s)}
                      onCheckedChange={() => toggleSet(statusFilter, s, setStatusFilter)}
                    >
                      <StatusIcon status={s} /> {STATUS_META[s].label}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Priority</DropdownMenuLabel>
                  {PRIORITY_ORDER.map((p) => (
                    <DropdownMenuCheckboxItem
                      key={p}
                      checked={priorityFilter.has(p)}
                      onCheckedChange={() => toggleSet(priorityFilter, p, setPriorityFilter)}
                    >
                      <PriorityIcon priority={p} /> {PRIORITY_META[p].label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* List | Board */}
              <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "board")}>
                <TabsList className="h-8 p-0.5">
                  <TabsTrigger value="list" className="h-7 px-2.5"><ListIcon className="size-3.5" /> List</TabsTrigger>
                  <TabsTrigger value="board" className="h-7 px-2.5"><KanbanSquare className="size-3.5" /> Board</TabsTrigger>
                </TabsList>
              </Tabs>

              <button
                onClick={newTask}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[13px] font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus className="size-3.5" /> New
              </button>
            </div>
          </header>

          {/* Active filter chips */}
          {filterCount > 0 && (
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
              {[...statusFilter].map((s) => (
                <FilterChip key={s} label={STATUS_META[s].label} onClear={() => toggleSet(statusFilter, s, setStatusFilter)} />
              ))}
              {[...priorityFilter].map((p) => (
                <FilterChip key={p} label={PRIORITY_META[p].label} onClear={() => toggleSet(priorityFilter, p, setPriorityFilter)} />
              ))}
              <button
                onClick={() => { setStatusFilter(new Set()); setPriorityFilter(new Set()) }}
                className="ml-1 text-[12px] text-dim hover:text-foreground"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <div className="m-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
            ) : tab === "board" ? (
              <BoardComingSoon />
            ) : (
              <TaskListView
                tasks={visibleTasks}
                loading={loading}
                meId={meId}
                isAdmin={isAdmin}
                selectedId={selectedId}
                emptyHint={view === "mine" ? "Nothing assigned to you in this view." : "Create a task or adjust your filters."}
                onOpen={openTask}
                onSetStatus={handleSetStatus}
                onEdit={openTask}
                onDelete={handleDelete}
                onHover={setSelectedId}
                onCreate={newTask}
              />
            )}
          </div>
        </main>
      </div>

      <TaskFormDialog
        open={form.open}
        onOpenChange={(o) => !o && setForm({ open: false })}
        mode={form.open ? form.mode : "create"}
        task={form.open ? form.task : null}
        caps={form.open && form.task ? classify(form.task, meId, isAdmin) : null}
        meId={meId}
        users={users}
        projects={projects}
        onSubmit={handleSubmit}
        onDelete={form.open && form.task ? () => { const t = form.task!; setForm({ open: false }); handleDelete(t) } : undefined}
      />

      <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} onCreate={handleCreateProject} />

      <CommandPalette
        open={cmdkOpen}
        onOpenChange={setCmdkOpen}
        tasks={allTasks}
        projects={projects}
        onNewTask={newTask}
        onSelectView={selectView}
        onSelectProject={selectProject}
        onOpenTask={openTask}
      />

      <Toaster />
    </TooltipProvider>
  )
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[12px]">
      {label}
      <button onClick={onClear} className="text-dim hover:text-foreground"><X className="size-3" /></button>
    </span>
  )
}

function BoardComingSoon() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-3xl">
        <div className="grid grid-cols-4 gap-3 opacity-40">
          {BOARD_STATUSES.map((s) => (
            <div key={s} className="rounded-lg border border-border bg-elevated/40 p-2">
              <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium">
                <StatusIcon status={s} /> {STATUS_META[s].label}
              </div>
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="mb-2 h-12 rounded-md border border-border bg-card" />
              ))}
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          Board view — draggable columns are coming next. Review the List view first.
        </p>
      </div>
    </div>
  )
}
