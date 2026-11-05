import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('ui-input flex min-h-24 w-full rounded-xl border border-input bg-input/20 px-3.5 py-3 text-base shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 md:text-sm', className)} {...props} />;
}
