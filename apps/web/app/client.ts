import { createClient } from 'honox/client'
import { initCustomSelects } from './components/ui/custom-select-client'
import { initLoginCardFocus } from './features/auth/login-card-focus-client'
import { initPublicCardPreview } from './features/public-card/client-preview'
import { initDashboardTrendTooltip } from './features/usage/dashboard-trend-tooltip'
import { initTheme } from './lib/theme-client'
import { isValidTimezone, timezoneCookieName } from './lib/timezone'
import { initDeviceDetailsDialogs } from './client-device-dialog'
import { initConfirmableActions, initCopyButtons, initSubmitFeedback } from './client-interactions'
import { initAppNavigation } from './client-navigation'
import { initFolioTabs } from './folio-interactive-client'

createClient()
initTheme()
initBrowserTimezone()
initTimezoneInputs()
initCopyButtons()
initConfirmableActions()
initDeviceDetailsDialogs()
initSubmitFeedback()
initLoginCardFocus()
initAppNavigation(initTimezoneInputs)
initCustomSelects()
initPublicCardPreview()
initDashboardTrendTooltip()
initFolioTabs()

function initBrowserTimezone() {
  const timezone = detectBrowserTimezone()
  if (!timezone) return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${timezoneCookieName}=${encodeURIComponent(timezone)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

function initTimezoneInputs() {
  const timezone = detectBrowserTimezone()
  if (!timezone) return
  document.querySelectorAll<HTMLInputElement>('[data-timezone-input]').forEach((input) => {
    const mode = input.dataset.timezoneAutofill
    if (mode !== 'true' && mode !== 'always') return
    if (mode === 'always') {
      input.value = timezone
      return
    }
    const initialValue = input.dataset.timezoneDefault?.trim() || input.defaultValue.trim()
    const currentValue = input.value.trim()
    if (currentValue && currentValue !== 'UTC' && initialValue !== 'UTC') return
    input.value = timezone
  })
}

function detectBrowserTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimezone(timezone) ? timezone : null
  } catch (_) {
    return null
  }
}
