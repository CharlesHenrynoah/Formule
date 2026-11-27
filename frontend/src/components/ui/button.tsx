import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const button = cva('inline-flex items-center justify-center gap-2 rounded-full border text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-30', {
  variants: {
    variant: {
      primary: 'border-white bg-white text-black hover:bg-neutral-200',
      ghost: 'border-transparent text-mute hover:border-edge hover:text-ink',
      outline: 'border-edge text-ink hover:border-edge-strong',
      danger: 'border-edge-strong bg-transparent text-ink hover:bg-raised',
      metal: 'metal',
    },
    size: { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3', lg: 'h-10 px-4', icon: 'h-8 w-8' },
  },
  defaultVariants: { variant: 'outline', size: 'md' },
});

export function Button({ className, variant, size, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  const skewed = false;
  return <button className={cn(button({ variant, size }), className)} {...p}>{skewed ? <span className="unskew">{children}</span> : children}</button>;
}
