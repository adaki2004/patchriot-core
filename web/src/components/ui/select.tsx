import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import './select.css';

type Option = { value: string; label: string; description?: string };

export function Select({ id, label, value, placeholder, options, disabled, onValueChange }: {
  id: string; label: string; value: string; placeholder: string; options: Option[];
  disabled?: boolean; onValueChange: (value: string) => void;
}) {
  return <Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <Primitive.Trigger id={id} aria-label={label} className="ui-select-trigger">
      <Primitive.Value placeholder={placeholder} />
      <Primitive.Icon><ChevronDown size={16} /></Primitive.Icon>
    </Primitive.Trigger>
    <Primitive.Portal>
      <Primitive.Content className="ui-select-content" position="popper" sideOffset={6} collisionPadding={12}>
        <Primitive.ScrollUpButton className="ui-select-scroll"><ChevronUp size={16} /></Primitive.ScrollUpButton>
        <Primitive.Viewport>
          {options.map(option => <Primitive.Item key={option.value} value={option.value} textValue={option.label} className="ui-select-option">
            <span className="ui-select-check"><Primitive.ItemIndicator><Check size={16} /></Primitive.ItemIndicator></span>
            <span className="ui-select-copy"><Primitive.ItemText>{option.label}</Primitive.ItemText>{option.description && <small>{option.description}</small>}</span>
          </Primitive.Item>)}
        </Primitive.Viewport>
        <Primitive.ScrollDownButton className="ui-select-scroll"><ChevronDown size={16} /></Primitive.ScrollDownButton>
      </Primitive.Content>
    </Primitive.Portal>
  </Primitive.Root>;
}
