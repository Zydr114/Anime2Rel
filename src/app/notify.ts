import { snackbar } from 'mdui/functions/snackbar.js'
import { confirm } from 'mdui/functions/confirm.js'
import { prompt } from 'mdui/functions/prompt.js'

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

/** 让用户输入一行文本；取消时返回 null。 */
export async function askText(headline: string, value: string, confirmText: string, cancelText: string): Promise<string | null> {
  try {
    return await prompt({ headline, confirmText, cancelText, closeOnEsc: true, textFieldOptions: { value } })
  } catch {
    return null
  }
}
