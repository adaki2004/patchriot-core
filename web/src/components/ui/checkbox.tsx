import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
export function Checkbox({className,...props}:ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root data-slot="checkbox" className={cn('ui-checkbox peer size-5 shrink-0 rounded-md border border-input shadow-xs transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',className)} {...props}><Primitive.Indicator className="flex items-center justify-center"><Check className="size-3.5"/></Primitive.Indicator></Primitive.Root>;
}
