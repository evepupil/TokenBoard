import type { Child } from 'hono/jsx'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-bar)] focus-visible:ring-offset-1 disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border border-[var(--app-border-strong)] bg-[var(--app-text)] text-[var(--app-bg)] hover:border-[var(--app-accent-bar)] hover:bg-[var(--app-accent-bar)] hover:text-white',
        secondary:
          'border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] text-[var(--app-text)] hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]',
        ghost:
          'border border-transparent text-[var(--app-muted)] hover:border-[var(--app-border)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]',
        destructive:
          'border border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] hover:border-[var(--app-danger-text)] hover:bg-[var(--app-danger-text)] hover:text-white'
      },
      size: {
        default: 'min-h-11 px-4 py-2.5',
        sm: 'min-h-9 px-3 py-1.5 text-xs',
        lg: 'min-h-11 px-5 py-3'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ButtonProps = VariantProps<typeof buttonVariants> & {
  class?: string
  type?: 'button' | 'submit' | 'reset'
  name?: string
  value?: string
  disabled?: boolean
  children?: Child
  'data-submitting-label'?: string
  'data-submitting-tone'?: string
  'data-confirm'?: string
}

type LinkButtonProps = VariantProps<typeof buttonVariants> & {
  class?: string
  href: string
  download?: string
  children?: Child
}

export function Button(props: ButtonProps) {
  const { class: className, variant, size, children, ...rest } = props
  return (
    <button class={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {children}
    </button>
  )
}

export function LinkButton(props: LinkButtonProps) {
  return (
    <a
      class={cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)}
      data-link-button="true"
      href={props.href}
      download={props.download}
    >
      {props.children}
    </a>
  )
}
