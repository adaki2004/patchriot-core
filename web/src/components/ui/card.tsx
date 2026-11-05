import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
export function Card({className,...props}:ComponentProps<'section'>) { return <section data-slot="card" className={cn('ui-card rounded-2xl border border-border bg-card text-card-foreground shadow-sm',className)} {...props}/>; }
export function CardHeader({className,...props}:ComponentProps<'div'>) { return <div data-slot="card-header" className={cn('px-6 pt-6 pb-4',className)} {...props}/>; }
export function CardTitle({className,...props}:ComponentProps<'h2'>) { return <h2 data-slot="card-title" className={cn('text-xl leading-tight font-semibold tracking-tight',className)} {...props}/>; }
export function CardDescription({className,...props}:ComponentProps<'p'>) { return <p data-slot="card-description" className={cn('mt-2 text-sm text-muted-foreground',className)} {...props}/>; }
export function CardContent({className,...props}:ComponentProps<'div'>) { return <div data-slot="card-content" className={cn('px-6 pb-6',className)} {...props}/>; }
