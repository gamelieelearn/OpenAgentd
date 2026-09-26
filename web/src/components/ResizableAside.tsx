/**
 * ResizableAside — a side panel whose drag-resize re-renders only itself.
 *
 * ``usePanelResize`` tracks the live width in state, one update per frame.
 * Owning it here, with the panel body passed in as ``children``, means a drag
 * re-renders this wrapper and the ``PanelResizeHandle`` (which reads the live
 * handle props from context), while React skips the unchanged ``children``
 * subtree. The owner (sidebar, review dock) renders once, on commit.
 *
 * Width stays a framer-motion ``animate`` target so open/close tweens and the
 * drag share one value; ``getMotion`` maps the live width to motion props.
 */
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'
import { motion, type TargetAndTransition, type Transition } from 'framer-motion'

import { panelResizeHandleClass, usePanelResize, type PanelResizeOptions } from '@/hooks/use-panel-resize'

type ResizeState = ReturnType<typeof usePanelResize>

const ResizeContext = createContext<ResizeState | null>(null)

export interface LiveWidth {
  width: number
  isResizing: boolean
}

interface ResizableAsideProps
  extends Omit<ComponentProps<typeof motion.aside>, 'animate' | 'transition' | 'children'> {
  resize: PanelResizeOptions
  getMotion: (live: LiveWidth) => { animate: TargetAndTransition; transition: Transition }
  children: ReactNode
}

export function ResizableAside({ resize, getMotion, children, ...asideProps }: ResizableAsideProps) {
  const state = usePanelResize(resize)
  const { animate, transition } = getMotion({ width: state.width, isResizing: state.isResizing })
  return (
    <ResizeContext.Provider value={state}>
      <motion.aside {...asideProps} animate={animate} transition={transition}>
        {children}
      </motion.aside>
    </ResizeContext.Provider>
  )
}

/** The separator for the enclosing ``ResizableAside``; place it where the edge is. */
export function PanelResizeHandle({ edge }: { edge: 'left' | 'right' }) {
  const state = useContext(ResizeContext)
  if (!state) return null
  return <div {...state.handleProps} className={panelResizeHandleClass(edge, state.isResizing)} />
}
