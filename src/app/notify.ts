import { snackbar } from 'mdui/functions/snackbar.js'
import { confirm } from 'mdui/functions/confirm.js'

export function notify(message: string): void {
  snackbar({ message, placement: 'bottom', autoCloseDelay: 4000, closeable: true })
}

/** 返回用户是否确认。 */
export async function ask(headline: string, description: string, confirmText: string, cancelText: string): Promise<boolean> {
  try {
    await confirm({ headline, description, confirmText, cancelText, closeOnEsc: true })
    return true
  } catch {
    return false
  }
}
