/**
 * TasksTabView — the agent's task list as a review-dock tab (desktop ⌘T).
 *
 * Same checklist as the mobile popover, but rows wrap instead of truncating
 * since the dock's width varies and there is room for the full text.
 */
import { ListTodo } from 'lucide-react'
import type { TodoItem } from '@/api/types'
import { cn } from '@/lib/utils'
import { TaskChecklist, TaskProgressBar, summarizeTodos } from '../TaskChecklist'

export interface TasksTabViewProps {
  todos: TodoItem[]
  sessionId: string | null
}

export function TasksTabView({ todos, sessionId }: TasksTabViewProps) {
  const summary = summarizeTodos(todos)

  if (summary.total === 0) {
    return (
      <div role="status" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <ListTodo size={16} aria-hidden="true" className="text-(--color-text-subtle)" />
        <p className="text-xs font-medium text-(--color-text-2)">
          {sessionId ? 'No tasks yet' : 'No active session'}
        </p>
        <p className="max-w-64 text-xs text-(--color-text-subtle)">
          {sessionId
            ? 'The agent lists its steps here when it plans multi-step work.'
            : 'Start a session to see the agent\u2019s task list.'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center px-3">
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            summary.allDone ? 'text-(--color-success)' : 'text-(--color-text-muted)',
          )}
        >
          {summary.finished}/{summary.total} done
        </span>
      </div>
      <TaskProgressBar summary={summary} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        <TaskChecklist todos={todos} overflow="wrap" className="space-y-px p-1.5" />
      </div>
    </div>
  )
}
