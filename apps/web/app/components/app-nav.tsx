import { Moon, Sun } from 'lucide'
import { cn } from '../lib/cn'
import { SkipLinkTarget } from './skip-link-target'
import { GitHubMark, LucideIcon } from './ui/icon'

type AppNavProps = {
  active?: 'dashboard' | 'details' | 'leaderboards' | 'install' | 'profile' | 'devices' | 'notifications'
  email?: string
  isAuthenticated?: boolean
  compact?: boolean
}

const repositoryUrl = 'https://github.com/evepupil/TokenBoard'
const iconButtonClass =
  'inline-flex h-10 w-10 items-center justify-center border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] text-[var(--app-text)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]'
const signOutButtonClass =
  'min-h-10 border border-[var(--app-border-strong)] bg-transparent px-3.5 py-2 text-xs font-bold text-[var(--app-text)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]'

export function AppNav(props: AppNavProps) {
  const isAuthenticated = props.isAuthenticated ?? Boolean(props.email)

  return (
    <>
      <nav
        aria-label="主导航"
        class={cn(
          'app-folio-container flex flex-col gap-3 border-b border-[var(--app-border)] pb-4 text-[var(--app-text)] xl:flex-row xl:items-center xl:justify-between',
          props.compact ? 'mb-3 xl:py-2' : 'mb-6 pt-1'
        )}
      >
        <div class="flex min-w-0 items-center justify-between gap-3">
          <a class="group flex min-w-0 items-center gap-3" href={isAuthenticated ? '/dashboard' : '/'}>
            <img
              class="app-logo-elevation h-9 w-9 shrink-0 transition group-hover:opacity-90"
              src="/logo.svg"
              alt="TokenBoard"
              width="36"
              height="36"
            />
            <span class="block truncate text-base font-extrabold tracking-tight text-[var(--app-text)]">
              TokenBoard
            </span>
          </a>
          <div class="flex shrink-0 items-center gap-2 xl:hidden">
            <ThemeToggle />
            <RepositoryLink />
          </div>
        </div>

        <div class="-mx-1 px-1">
          <div class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            {isAuthenticated ? (
              <NavLink compact={props.compact} href="/dashboard" active={props.active === 'dashboard'} index="01">
                控制台
              </NavLink>
            ) : null}
            {isAuthenticated ? (
              <NavLink compact={props.compact} href="/dashboard/details" active={props.active === 'details'} index="02">
                详情
              </NavLink>
            ) : null}
            <NavLink
              compact={props.compact}
              href="/leaderboards"
              active={props.active === 'leaderboards'}
              index={isAuthenticated ? '03' : '01'}
            >
              排行榜
            </NavLink>
            {isAuthenticated ? (
              <NavLink
                compact={props.compact}
                href="/settings/install"
                active={props.active === 'install'}
                shortLabel="安装"
                index="04"
              >
                安装采集器
              </NavLink>
            ) : null}
            {isAuthenticated ? (
              <NavLink compact={props.compact} href="/settings/devices" active={props.active === 'devices'} index="05">
                设备
              </NavLink>
            ) : null}
            {isAuthenticated ? (
              <NavLink
                compact={props.compact}
                href="/settings/notifications"
                active={props.active === 'notifications'}
                index="06"
              >
                通知
              </NavLink>
            ) : null}
            {isAuthenticated ? (
              <NavLink
                compact={props.compact}
                href="/settings/profile"
                active={props.active === 'profile'}
                shortLabel="资料"
                index="07"
              >
                公开资料
              </NavLink>
            ) : null}
            {isAuthenticated ? null : (
              <NavLink compact={props.compact} href="/auth/sign-in" loginFocus index="02">
                登录
              </NavLink>
            )}
            {isAuthenticated ? (
              <form class="xl:hidden" method="post" action="/auth/sign-out" data-submit-feedback="true">
                <button class={signOutButtonClass} type="submit" data-submitting-label="正在退出...">
                  退出登录
                </button>
              </form>
            ) : null}
          </div>
        </div>

        <div class="hidden items-center gap-2 xl:flex">
          {props.email ? (
            <span class="max-w-44 truncate font-mono text-xs text-[var(--app-subtle)]">{props.email}</span>
          ) : null}
          <ThemeToggle />
          <RepositoryLink />
          {isAuthenticated ? (
            <form method="post" action="/auth/sign-out" data-submit-feedback="true">
              <button class={signOutButtonClass} type="submit" data-submitting-label="正在退出...">
                退出登录
              </button>
            </form>
          ) : null}
        </div>
      </nav>
      <SkipLinkTarget />
    </>
  )
}

function NavLink(props: {
  href: string
  active?: boolean
  compact?: boolean
  loginFocus?: boolean
  shortLabel?: string
  index?: string
  children: string
}) {
  return (
    <a
      class={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-transparent font-bold text-[var(--app-muted)] transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-panel-strong)] hover:text-[var(--app-text)] active:scale-[0.96]',
        props.compact ? 'px-3 py-2 text-xs' : 'px-3 py-2 text-xs sm:px-3.5 sm:py-2',
        props.active &&
          'border-[var(--app-border-strong)] bg-[var(--app-text)] text-[var(--app-bg)] hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]'
      )}
      data-app-nav-link="true"
      data-login-focus={props.loginFocus ? 'true' : undefined}
      aria-current={props.active ? 'page' : undefined}
      href={props.href}
    >
      {props.index ? (
        <span class={cn('font-mono text-[10px]', props.active ? 'opacity-70' : 'text-[var(--app-subtle)]')}>
          {props.index}
        </span>
      ) : null}
      {props.shortLabel ? (
        <>
          <span class="sm:hidden">{props.shortLabel}</span>
          <span class="hidden sm:inline">{props.children}</span>
        </>
      ) : (
        props.children
      )}
    </a>
  )
}

function RepositoryLink() {
  return (
    <a
      class={iconButtonClass}
      href={repositoryUrl}
      target="_blank"
      rel="noreferrer"
      aria-label="打开 GitHub 仓库"
      title="GitHub 仓库"
    >
      <GitHubMark size={16} />
    </a>
  )
}

function ThemeToggle() {
  return (
    <button
      class={iconButtonClass}
      type="button"
      data-theme-toggle="true"
      aria-label="切换明暗主题"
      title="切换明暗主题"
    >
      <span data-theme-icon="light">
        <LucideIcon icon={Sun} size={16} />
      </span>
      <span data-theme-icon="dark">
        <LucideIcon icon={Moon} size={16} />
      </span>
    </button>
  )
}
