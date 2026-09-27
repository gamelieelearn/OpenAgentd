import { useEffect, useState } from 'react'

function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible'
}

/** Whether the page is on screen (not a background tab or minimised window). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isDocumentVisible)
  useEffect(() => {
    const onVisibilityChange = () => setVisible(isDocumentVisible())
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
  return visible
}
