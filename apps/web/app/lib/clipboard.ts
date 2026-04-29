type ClipboardWriter = {
  writeText(text: string): Promise<void>
}

export async function copyTextToClipboard(
  clipboard: ClipboardWriter | undefined,
  text: string
) {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false

  try {
    await clipboard.writeText(text)
    return true
  } catch (_) {
    return false
  }
}
