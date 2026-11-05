import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(type === 'checkbox' ? 'ui-native-checkbox' : 'ui-input flex h-12 w-full min-w-0 rounded-xl border border-input bg-input/20 px-3.5 text-base shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm', className)} {...props} />;
}
