import { useEffect, useState } from 'react'
import { X, Plus, CalendarClock, ArrowLeft } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useScheduledTasksQuery,
} from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/stores/useUIStore'
import { AppOverlay } from '@/components/ui/app-overlay'
import { CreateTaskForm } from './SchedulerPanel/CreateTaskForm'
import { TaskDetailView } from './SchedulerPanel/TaskDetailView'
import { TaskListPane } from './SchedulerPanel/TaskListPane'

interface SchedulerPanelProps {
  open: boolean
  onClose: () => void
  /** Workspace inherited from the surrounding chat view. */
  contextWorkspace?: string | null
}

export function SchedulerPanel({
  open,
  onClose,
  contextWorkspace = null,
}: SchedulerPanelProps) {
  const isMobile = useIsMobile()

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [mobilePane, setMobilePane] = useState<'list' | 'detail' | 'create'>('list')

  const tasksQuery = useScheduledTasksQuery()
  const { refetch: refetchTasks } = tasksQuery

  useEffect(() => {
    if (open) {
      refetchTasks()
    }
  }, [open, refetchTasks])

  const tasks = tasksQuery.data?.tasks ?? []

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null

  const focusTaskId = useUIStore((s) => s.scheduledTaskFocus)
  useEffect(() => {
    if (!open || !focusTaskId) return
    setSelectedTaskId(focusTaskId)
    if (isMobile) setMobilePane('detail')
    useUIStore.getState().focusScheduledTask(null)
  }, [focusTaskId, isMobile, open])

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id)
    if (isMobile) setMobilePane('detail')
  }

  const handleCloseDetail = () => {
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('list')
  }

  const handleTaskDeleted = (id: string) => {
    if (selectedTaskId === id) handleCloseDetail()
  }

  const handleOpenCreate = () => {
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('create')
  }

  const handleBackToList = () => {
    setMobilePane('list')
  }

  const showList = !isMobile || mobilePane === 'list'
  const showDetail = !isMobile || mobilePane === 'detail' || mobilePane === 'create'

  return (
    <AppOverlay
      open={open}
      onClose={onClose}
      label="Scheduled tasks"
      maxWidth="1100px"
    >
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Mobile back button */}
          {isMobile && mobilePane !== 'list' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={handleBackToList}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
                    aria-label="Back to task list"
                  >
                    <ArrowLeft size={14} />
                  </button>
                }
              />
              <TooltipContent>Back to task list</TooltipContent>
            </Tooltip>
          )}
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent)">
              <CalendarClock size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-bold text-(--color-text)">
                  {isMobile && mobilePane === 'create'
                    ? 'Create Task'
                    : isMobile && mobilePane === 'detail'
                      ? (selectedTask?.name ?? 'Task')
                      : 'Scheduled Tasks'}
                </h2>
                {tasks.length > 0 && (!isMobile || mobilePane === 'list') && (
                  <span className="rounded-full bg-(--bg-key) px-1.5 py-0.2 font-mono text-xs md:text-[11px] font-semibold text-(--color-text-subtle)">
                    {tasks.length}
                  </span>
                )}
              </div>
              {(!isMobile || mobilePane === 'list') && (
                <Tooltip className="min-w-0">
                  <TooltipTrigger
                    className="min-w-0"
                    render={<p className="truncate text-[11px] text-(--color-text-muted)">All scheduled tasks</p>}
                  />
                  <TooltipContent>Scheduled tasks</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Desktop/Mobile: Create button */}
          {selectedTaskId !== null && !isMobile && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={handleOpenCreate}
                    className="flex h-7 items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-2 text-xs font-medium text-(--color-text) transition-colors hover:bg-(--bg-key) hover:border-(--color-border-strong)"
                    aria-label="Create new task"
                  >
                    <Plus size={12} />
                    <span>New Task</span>
                  </button>
                }
              />
              <TooltipContent>Create new task</TooltipContent>
            </Tooltip>
          )}
          {isMobile && mobilePane === 'list' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={handleOpenCreate}
                    className="flex h-9 w-9 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key) md:h-7 md:w-7"
                    aria-label="Create new task"
                  >
                    <Plus size={13} />
                  </button>
                }
              />
              <TooltipContent>Create task</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  onClick={onClose}
                  className="flex h-9 w-9 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
                  aria-label="Close scheduler panel"
                >
                  <X size={14} />
                </button>
              }
            />
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* List panel */}
        {showList && (
          <div className={`flex flex-col bg-(--bg-sidebar) ${isMobile ? 'w-full' : 'w-96 shrink-0 border-r border-(--color-border)'}`}>
            <TaskListPane
              tasks={tasks}
              isLoading={tasksQuery.isLoading}
              isError={tasksQuery.isError}
              selectedTaskId={selectedTaskId}
              onSelect={handleSelectTask}
              onDeleted={handleTaskDeleted}
              emptyHint={isMobile ? undefined : 'Use the form on the right to create one.'}
            />
          </div>
        )}

        {/* Detail / Create panel */}
        {showDetail && (
          // Container, not viewport, breakpoints: the same forms render in
          // the review dock's Schedule tab at a fraction of the window.
          <div className="@container flex flex-1 flex-col overflow-hidden">
            {selectedTask && (!isMobile || mobilePane === 'detail') ? (
              <TaskDetailView
                task={selectedTask}
                onClose={handleCloseDetail}
              />
            ) : (
              <CreateTaskForm
                key={`create-${contextWorkspace ?? ''}`}
                contextWorkspace={contextWorkspace}
                onSuccess={handleCloseDetail}
              />
            )}
          </div>
        )}
      </div>
    </AppOverlay>
  )
}

export { ModeWorkspaceFields } from './SchedulerPanel/ModeWorkspaceFields'
