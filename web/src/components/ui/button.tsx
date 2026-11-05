import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const variants = cva('ui-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2', {
  variants: {
    variant: { default: 'bg-primary text-primary-foreground hover:brightness-110', secondary: 'bg-secondary text-secondary-foreground hover:bg-accent', outline: 'border border-input bg-transparent hover:bg-accent', ghost: 'bg-transparent hover:bg-accent', destructive: 'bg-destructive text-white' },
    size: { default: 'h-11 px-5', sm: 'h-9 px-3 text-xs', lg: 'h-12 px-6', icon: 'size-10 p-0' },
  }, defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({ className, variant, size, asChild = false, ...props }: ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component data-slot="button" data-variant={variant ?? 'default'} data-size={size ?? 'default'} className={cn(variants({ variant, size, className }))} {...props} />;
}
