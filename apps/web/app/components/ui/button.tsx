import { cva, type VariantProps } from 'class-variance-authority'
import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-lime-300 text-stone-950 hover:bg-lime-200',
        secondary: 'border border-stone-700 bg-stone-950 text-stone-100 hover:border-lime-300 hover:text-lime-100',
        ghost: 'text-stone-300 hover:bg-stone-800 hover:text-stone-50',
        destructive: 'bg-red-400 text-stone-950 hover:bg-red-300'
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-12 px-5 text-base',
        icon: 'h-10 w-10'
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
  disabled?: boolean
  children?: Child
}

export function Button(props: ButtonProps) {
  const { variant, size, class: className, ...rest } = props
  return <button class={cn(buttonVariants({ variant, size }), className)} {...rest} />
}

type LinkButtonProps = VariantProps<typeof buttonVariants> & {
  class?: string
  href: string
  children?: Child
}

export function LinkButton(props: LinkButtonProps) {
  const { variant, size, class: className, ...rest } = props
  return <a class={cn(buttonVariants({ variant, size }), className)} {...rest} />
}
