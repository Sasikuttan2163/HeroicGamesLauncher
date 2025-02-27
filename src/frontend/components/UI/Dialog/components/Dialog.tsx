import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import React, {
  ReactNode,
  SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

interface DialogProps {
  className?: string
  children: ReactNode
  showCloseButton: boolean
  onClose: () => void
}

export const Dialog: React.FC<DialogProps> = ({
  children,
  className,
  showCloseButton = false,
  onClose
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [focusOnClose, setFocusOnClose] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setFocusOnClose(document.querySelector('*:focus') as HTMLElement)
  }, [])

  const close = () => {
    onCloseRef.current()
    if (focusOnClose) {
      setTimeout(() => focusOnClose.focus(), 200)
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog) {
      const cancel = () => {
        close()
      }
      dialog.addEventListener('cancel', cancel)
      dialog['showPopover']()

      return () => {
        dialog.removeEventListener('cancel', cancel)
        dialog['hidePopover']()
      }
    }
    return
  }, [dialogRef.current])

  const onDialogClick = useCallback(
    (e: SyntheticEvent) => {
      if (e.target === dialogRef.current) {
        const ev = e.nativeEvent as MouseEvent
        const tg = e.target as HTMLElement
        if (
          ev.offsetX < 0 ||
          ev.offsetX > tg.offsetWidth ||
          ev.offsetY < 0 ||
          ev.offsetY > tg.offsetHeight
        ) {
          close()
        }
      }
    },
    [onClose]
  )

  return (
    <div className="Dialog">
      <dialog
        className={`Dialog__element ${className}`}
        ref={dialogRef}
        onClick={onDialogClick}
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore, this feature is new and not yet typed
        popover="manual"
      >
        {showCloseButton && (
          <div className="Dialog__Close">
            <button className="Dialog__CloseButton" onClick={close}>
              <FontAwesomeIcon className="Dialog__CloseIcon" icon={faXmark} />
            </button>
          </div>
        )}
        {children}
      </dialog>
    </div>
  )
}
