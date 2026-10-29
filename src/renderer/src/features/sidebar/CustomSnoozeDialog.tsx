import { useEffect, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button, Dialog, DialogFooter, Input, Modal, ModalOverlay, Notice, TextField } from '../../ui'
import { customSnoozeUntil, localDateValue, localTimeValue } from './session-snooze'

const HOUR_MS = 3_600_000

export interface CustomSnoozeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (until: number) => void
}

export function CustomSnoozeDialog({ open, onOpenChange, onSubmit }: CustomSnoozeDialogProps): JSX.Element {
  const t = useT()
  const [date, setDate] = useState(() => localDateValue(Date.now() + HOUR_MS))
  const [time, setTime] = useState(() => localTimeValue(Date.now() + HOUR_MS))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!open) return
    const at = Date.now() + HOUR_MS
    setDate(localDateValue(at))
    setTime(localTimeValue(at))
    setInvalid(false)
  }, [open])

  const submit = (close: () => void): void => {
    const until = customSnoozeUntil(date, time, Date.now())
    if (until === null) {
      setInvalid(true)
      return
    }
    close()
    onSubmit(until)
  }

  return (
    <ModalOverlay isDismissable isOpen={open} onOpenChange={onOpenChange}>
      <Modal>
        <Dialog title={t('rail.snoozeCustomTitle')} closeLabel={t('ui.close')} data-testid="v3-snooze-custom">
          {({ close }) => (
            <form
              className="v3-confirm"
              onSubmit={(event) => {
                event.preventDefault()
                submit(close)
              }}
            >
              <p className="v3-confirm-body">{t('rail.snoozeCustomBody')}</p>
              <div className="v3-snooze-fields">
                <TextField
                  aria-labelledby="v3-snooze-date-label"
                  value={date}
                  onChange={(next) => {
                    setDate(next)
                    setInvalid(false)
                  }}
                >
                  <span className="v3-field-label" id="v3-snooze-date-label">
                    {t('rail.snoozeCustomDate')}
                  </span>
                  <Input className="ui-input" type="date" data-testid="v3-snooze-date" />
                </TextField>
                <TextField
                  aria-labelledby="v3-snooze-time-label"
                  value={time}
                  onChange={(next) => {
                    setTime(next)
                    setInvalid(false)
                  }}
                >
                  <span className="v3-field-label" id="v3-snooze-time-label">
                    {t('rail.snoozeCustomTime')}
                  </span>
                  <Input className="ui-input" type="time" data-testid="v3-snooze-time" />
                </TextField>
              </div>
              {invalid ? (
                <Notice tone="fail" variant="hint" role="alert">
                  {t('rail.snoozeCustomInvalid')}
                </Notice>
              ) : null}
              <DialogFooter>
                <Button variant="secondary" onPress={close}>
                  {t('ui.cancel')}
                </Button>
                <Button type="submit" variant="primary" data-testid="v3-snooze-confirm">
                  {t('rail.snoozeCustomConfirm')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
