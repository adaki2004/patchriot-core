import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-tabs';
import { cn } from '../../lib/utils';
export function Tabs({className,...props}:ComponentProps<typeof Primitive.Root>) { return <Primitive.Root className={cn('flex flex-col gap-4',className)} {...props}/>; }
export function TabsList({className,...props}:ComponentProps<typeof Primitive.List>) { return <Primitive.List className={cn('ui-tabs-list inline-flex w-fit items-center gap-1 rounded-xl bg-muted p-1',className)} {...props}/>; }
export function TabsTrigger({className,...props}:ComponentProps<typeof Primitive.Trigger>) { return <Primitive.Trigger className={cn('ui-tab inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50',className)} {...props}/>; }
export function TabsContent({className,...props}:ComponentProps<typeof Primitive.Content>) { return <Primitive.Content className={cn('min-w-0 outline-none',className)} {...props}/>; }
