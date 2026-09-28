import { Download } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FilePreviewContent, CopyButton, canCopyFileContents } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { formatBytes } from '@/utils/format'
import type { WorkspaceFileInfo } from '@/api/types'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

interface FilePreviewSubPanelProps {
  workspace: string
  file: WorkspaceFileInfo
  onAddComment?: (path: string, startLine: number, endLine: number) => void
}

/** A file tab: one 32px toolbar (path, size, actions) over the preview. */
export function FilePreviewSubPanel({
  workspace,
  file,
  onAddComment,
}: FilePreviewSubPanelProps) {
  const deleted = file.deleted === true
  const downloadLabel = deleted ? 'File deleted from workspace' : 'Download file'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) pr-1 pl-3">
        <FileTypeIcon name={file.name || file.path} size={13} />
        <Tooltip className="min-w-0 flex-1">
          <TooltipTrigger
            className="min-w-0 flex-1"
            render={<p className="truncate font-mono text-xs text-(--color-text)">{file.path}</p>}
          />
          <TooltipContent side="bottom">{file.path}</TooltipContent>
        </Tooltip>
        {file.size > 0 && (
          <span className="hidden shrink-0 font-mono text-[11px] text-(--color-text-subtle) md:inline">{formatBytes(file.size)}</span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void downloadWorkspaceFile(workspace, file)}
                  disabled={deleted}
                  aria-label={downloadLabel}
                  className={DOCK_ACTION_BUTTON_CLASS}
                >
                  <Download size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">{downloadLabel}</TooltipContent>
          </Tooltip>
          {canCopyFileContents(file) && <CopyButton workspace={workspace} file={file} />}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FilePreviewContent workspace={workspace} file={file} onAddComment={onAddComment} />
      </div>
    </div>
  )
}
