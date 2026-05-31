import { Moon, Sun } from 'lucide'
import { cn } from '../lib/cn'
import { GitHubMark, LucideIcon } from './ui/icon'

type AppNavProps = {
  active?: 'dashboard' | 'details' | 'leaderboards' | 'install' | 'profile' | 'devices' | 'notifications'
  email?: string
  isAuthenticated?: boolean
}

const repositoryUrl = 'https://github.com/evepupil/TokenBoard'
const iconButtonClass = 'inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--app-border)] text-[var(--app-muted)] transition hover:border-lime-300 hover:text-[var(--app-text)]'
const signOutButtonClass = 'min-h-11 rounded-xl border border-[var(--app-border)] px-4 py-3 text-xs font-bold text-[var(--app-muted)] transition hover:border-lime-300 hover:text-[var(--app-text)]'

export function AppNav(props: AppNavProps) {
  const isAuthenticated = props.isAuthenticated ?? Boolean(props.email)

  return (
    <nav class="mx-auto mb-6 flex max-w-6xl flex-col gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-3 text-[var(--app-text)] shadow-xl shadow-black/10 backdrop-blur sm:px-4 xl:flex-row xl:items-center xl:justify-between">
      <div class="flex items-center justify-between gap-3">
        <a class="group flex items-center gap-3" href={isAuthenticated ? '/dashboard' : '/'}>
          <img
            class="h-10 w-10 rounded-xl shadow-lg shadow-lime-950/20 transition group-hover:rotate-3"
            src="/logo.svg"
            alt="TokenBoard"
            width="40"
            height="40"
          />
          <span>
            <span class="block text-base font-black tracking-tight text-[var(--app-text)]">TokenBoard</span>
            <span class="block text-xs text-[var(--app-muted)]">AI token 使用统计</span>
          </span>
        </a>
        <div class="flex items-center gap-2 xl:hidden">
          <ThemeToggle />
          <RepositoryLink />
        </div>
      </div>

      <div class="app-scrollbar-none -mx-3 overflow-x-auto px-3 xl:mx-0 xl:overflow-visible xl:px-0" data-app-nav-scroll="true">
        <div class="flex min-w-max items-center gap-2 text-sm xl:min-w-0">
          {isAuthenticated ? <NavLink href="/dashboard" active={props.active === 'dashboard'}>控制台</NavLink> : null}
          {isAuthenticated ? <NavLink href="/dashboard/details" active={props.active === 'details'}>详情</NavLink> : null}
          <NavLink href="/leaderboards" active={props.active === 'leaderboards'}>排行榜</NavLink>
          {isAuthenticated ? <NavLink href="/settings/install" active={props.active === 'install'}>安装采集器</NavLink> : null}
          {isAuthenticated ? <NavLink href="/settings/devices" active={props.active === 'devices'}>设备</NavLink> : null}
          {isAuthenticated ? <NavLink href="/settings/notifications" active={props.active === 'notifications'}>通知</NavLink> : null}
          {isAuthenticated ? <NavLink href="/settings/profile" active={props.active === 'profile'}>公开资料</NavLink> : null}
          {isAuthenticated ? null : <NavLink href="/auth/sign-in">登录</NavLink>}
          {isAuthenticated ? (
            <form class="xl:hidden" method="post" action="/auth/sign-out">
              <button class={signOutButtonClass} type="submit">退出登录</button>
            </form>
          ) : null}
        </div>
      </div>

      <div class="hidden items-center gap-2 xl:flex">
        {props.email ? <span class="max-w-48 truncate text-xs text-[var(--app-muted)]">{props.email}</span> : null}
        <ThemeToggle />
        <RepositoryLink />
        {isAuthenticated ? (
          <form method="post" action="/auth/sign-out">
            <button class={signOutButtonClass} type="submit">退出登录</button>
          </form>
        ) : null}
      </div>
    </nav>
  )
}

function NavLink(props: { href: string; active?: boolean; children: string }) {
  return (
    <a
      class={cn(
        'rounded-xl px-4 py-3 font-bold text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]',
        props.active && 'bg-lime-300 text-stone-950 shadow-sm shadow-lime-950/10 hover:bg-lime-300 hover:text-stone-950'
      )}
      href={props.href}
    >
      {props.children}
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
      <GitHubMark size={17} />
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
      <span data-theme-icon="light"><LucideIcon icon={Sun} size={17} /></span>
      <span data-theme-icon="dark"><LucideIcon icon={Moon} size={17} /></span>
    </button>
  )
}
