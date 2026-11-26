// A searchable select (PatternFly's typeahead Select): type to filter, the
// arrow keys and Enter to choose, the clear button for the empty choice.
// The first entry is the empty choice (`none`), so "keep the image's" is a
// visible option and not only an empty field.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, MenuToggle, Select, SelectList, SelectOption, TextInputGroup, TextInputGroupMain, TextInputGroupUtilities,
  type MenuToggleElement,
} from '@patternfly/react-core';
import { TimesIcon } from '@patternfly/react-icons/dist/esm/icons/times-icon';
import type { Choice } from '../shared/windows-intl';

export function Picker({ id, value, choices, none, onChange, clearLabel, noMatch, showDetail = true }: {
  id: string; value: string; choices: Choice[]; none: string; onChange: (v: string) => void;
  clearLabel: string; noMatch: string;
  /** Show the code after the name in the field ("中文（中国） zh-CN"); the time zones' names say enough. */
  showDetail?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const chosen = choices.find((c) => c.value === value);
  const shownText = chosen ? (showDetail ? `${chosen.label} ${chosen.detail}` : chosen.label) : '';
  const all = useMemo(() => [{ value: '', label: none, detail: '', search: none.toLowerCase() }, ...choices], [choices, none]);
  const list = useMemo(() => {
    const words = (typed ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((c) => c.value && words.every((w) => c.search.includes(w))) : all;
  }, [all, typed]);

  // Opened on a chosen entry, the list starts there (the time zones are long).
  useEffect(() => {
    if (!open || typed !== null) return;
    const f = requestAnimationFrame(() => document.querySelector(`#${id}-list .pf-v6-c-menu__list-item [aria-selected="true"]`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(f);
  }, [open, typed, id]);

  const close = () => { setOpen(false); setTyped(null); setFocused(null); };
  const choose = (v: string) => { onChange(v); close(); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      if (!list.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setFocused((f) => (f === null ? (d > 0 ? 0 : list.length - 1) : (f + d + list.length) % list.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && focused !== null && list[focused]) choose(list[focused].value);
      else if (open && typed && list.length === 1) choose(list[0].value);
      else setOpen(!open);
    } else if (e.key === 'Escape') close();
  };

  const toggle = (ref: React.Ref<MenuToggleElement>) => (
    <MenuToggle ref={ref} variant="typeahead" isFullWidth isExpanded={open} aria-label={none}
      onClick={() => { setOpen(!open); input.current?.focus(); }}>
      <TextInputGroup isPlain>
        <TextInputGroupMain inputId={id} value={typed ?? shownText} placeholder={none} autoComplete="off" innerRef={input}
          role="combobox" isExpanded={open} aria-controls={`${id}-list`} spellCheck={false}
          onClick={() => setOpen(!open)} onKeyDown={key}
          onChange={(_e, v) => { setTyped(v); setFocused(null); if (!open) setOpen(true); }} />
        {(value || typed) && (
          <TextInputGroupUtilities>
            <Button variant="plain" aria-label={clearLabel} icon={<TimesIcon />}
              onClick={(e) => { e.stopPropagation(); onChange(''); setTyped(null); input.current?.focus(); }} />
          </TextInputGroupUtilities>
        )}
      </TextInputGroup>
    </MenuToggle>
  );

  return (
    <Select id={`${id}-select`} isOpen={open} selected={value} toggle={toggle} isScrollable maxMenuHeight="18rem"
      shouldFocusFirstItemOnOpen={false} shouldFocusToggleOnSelect={false}
      onOpenChange={(o) => { if (!o) close(); }} onSelect={(_e, v) => choose(String(v ?? ''))}>
      <SelectList id={`${id}-list`}>
        {list.length === 0
          ? <SelectOption isDisabled value="__none">{noMatch}</SelectOption>
          : list.map((c, i) => (
            <SelectOption key={c.value || '__empty'} value={c.value} isFocused={focused === i} description={c.detail || undefined}
              id={`${id}-opt-${i}`}>
              {c.label}
            </SelectOption>
          ))}
      </SelectList>
    </Select>
  );
}
