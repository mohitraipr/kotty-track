import type { Task, Project, TaskView } from "@/types"
import { hueFor, StatusIcon } from "@/lib/taskMeta"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Layers, CircleUser, Plus } from "lucide-react"

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  tasks: Task[]
  projects: Project[]
  onNewTask: () => void
  onSelectView: (v: TaskView) => void
  onSelectProject: (id: number) => void
  onOpenTask: (t: Task) => void
}

export function CommandPalette({ open, onOpenChange, tasks, projects, onNewTask, onSelectView, onSelectProject, onOpenTask }: Props) {
  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search tasks or jump to…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem value="new task create" onSelect={() => run(onNewTask)}>
            <Plus /> New task
          </CommandItem>
          <CommandItem value="all tasks" onSelect={() => run(() => onSelectView("all"))}>
            <Layers /> All tasks
          </CommandItem>
          <CommandItem value="my tasks" onSelect={() => run(() => onSelectView("mine"))}>
            <CircleUser /> My tasks
          </CommandItem>
        </CommandGroup>

        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((p) => (
              <CommandItem key={p.id} value={`project ${p.name} ${p.project_key}`} onSelect={() => run(() => onSelectProject(p.id))}>
                <span className="size-2.5 rounded-[3px]" style={{ background: p.color || `hsl(${hueFor(p.project_key)} 50% 58%)` }} />
                <span className="truncate">{p.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Tasks">
          {tasks.slice(0, 60).map((t) => (
            <CommandItem key={t.id} value={`${t.title} ${t.id} ${t.tags.join(" ")}`} onSelect={() => run(() => onOpenTask(t))}>
              <StatusIcon status={t.status} />
              <span className="truncate">{t.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
