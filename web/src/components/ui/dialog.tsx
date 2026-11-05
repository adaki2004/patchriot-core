import { useRef, type ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export function DialogContent({className,children,canClose=true,onOpenAutoFocus,onCloseAutoFocus,...props}:ComponentProps<typeof Primitive.Content> & {canClose?:boolean}) {
  const opener=useRef<HTMLElement | null>(null);
  return <Primitive.Portal><Primitive.Overlay className="ui-modal-overlay fixed inset-0 z-100 bg-black/70 backdrop-blur-xs"/><Primitive.Content className={cn('ui-modal fixed top-1/2 left-1/2 z-101 grid w-[calc(100%-2rem)] max-w-md gap-4 rounded-2xl border border-border bg-card p-6 text-foreground shadow-2xl',className)} onOpenAutoFocus={event=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;onOpenAutoFocus?.(event);}} onCloseAutoFocus={event=>{onCloseAutoFocus?.(event);if(!event.defaultPrevented){event.preventDefault();const target=opener.current;requestAnimationFrame(()=>{if(target?.isConnected)target.focus();});}}} {...props}>{children}<Primitive.Close disabled={!canClose} className="ui-modal-close absolute top-4 right-4 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2" aria-label="Close"><X className="size-4"/></Primitive.Close></Primitive.Content></Primitive.Portal>;
}
export function DialogTitle({className,...props}:ComponentProps<typeof Primitive.Title>) {return <Primitive.Title className={cn('pr-8 text-2xl leading-tight font-semibold tracking-tight',className)} {...props}/>;}
export function DialogDescription({className,...props}:ComponentProps<typeof Primitive.Description>) {return <Primitive.Description className={cn('text-sm leading-relaxed text-muted-foreground',className)} {...props}/>;}
