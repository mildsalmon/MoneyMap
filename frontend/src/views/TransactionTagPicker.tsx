import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { normalizeTag, tagKey } from "./transactionInputState";
import "./transaction-tags.css";

const MAX_TAGS = 20, MAX_LENGTH = 50, MAX_OPTIONS = 30;
interface Props {
  catalog: string[]; value: string[]; onChange: (tags: string[]) => void;
  disabled?: boolean; onComposingChange?: (value: boolean) => void;
}

/** Add one tag at a time; selected tags remain independent removable values. */
export function TransactionTagPicker({ catalog, value, onChange, disabled = false, onComposingChange }: Props) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [notice, setNotice] = useState("");
  const selected = new Set(value.map(tagKey));
  const normalized = normalizeTag(query), key = tagKey(normalized);
  const unique = [...new Map(catalog.map(tag => [tagKey(tag), tag])).values()];
  const matches = unique.filter(tag => !selected.has(tagKey(tag)) && tagKey(tag).includes(key));
  const exact = matches.find(tag => tagKey(tag) === key);
  const existing = exact ? [exact, ...matches.filter(tag => tag !== exact)] : matches;
  const options = existing.slice(0, MAX_OPTIONS).map(tag => ({ tag, create: false }));
  const tooLong = Array.from(normalized).length > MAX_LENGTH;
  const full = value.length >= MAX_TAGS;
  if (normalized && !tooLong && !selected.has(key) && !unique.some(tag => tagKey(tag) === key)) {
    options.push({ tag: normalized, create: true });
  }
  const expanded = open && !disabled && !full;
  const activeIndex = active >= 0 && active < options.length ? active : -1;
  useEffect(() => {
    if (expanded && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, id]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const add = (tag: string) => {
    if (disabled || full || selected.has(tagKey(tag))) return;
    onChange([...value, normalizeTag(tag)]);
    setQuery(""); setActive(-1); setOpen(false); setNotice(`${tag} 태그 선택됨`);
    if (value.length + 1 === MAX_TAGS) requestAnimationFrame(() => document.getElementById(`${id}-remove-${MAX_TAGS - 1}`)?.focus());
    else input.current?.focus();
  };
  const remove = (tag: string, index: number) => {
    if (disabled) return;
    onChange(value.filter((_, i) => i !== index));
    setNotice(`${tag} 태그 제거됨`);
    // Focus a surviving chip, then the input, so keyboard users keep their place.
    requestAnimationFrame(() => {
      const next = document.getElementById(`${id}-remove-${Math.min(index, value.length - 2)}`);
      (next ?? input.current)?.focus();
    });
  };
  const chooseTyped = () => {
    if (!normalized || tooLong || full) return;
    if (selected.has(key)) { setNotice("이미 선택한 태그입니다"); return; }
    add(unique.find(tag => tagKey(tag) === key) ?? normalized);
  };
  return <div className="field txn-tags transaction-tag-picker" onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); setActive(-1); }
  }}>
    <label htmlFor={`${id}-input`}>태그 <span>(선택·여러 개)</span></label>
    {!!value.length && <div className="selected-tags" aria-label="선택한 태그">{value.map((tag, index) =>
      <button id={`${id}-remove-${index}`} key={tag} type="button" className="badge tag" disabled={disabled}
        aria-label={`${tag} 태그 제거`} onClick={() => remove(tag, index)}>{tag} <span aria-hidden="true">×</span></button>
    )}</div>}
    <div className="tag-search">
      <div className="tag-entry"><input ref={input} id={`${id}-input`} role="combobox" aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={`${id}-hint`} aria-invalid={tooLong || undefined}
        placeholder="태그 검색 또는 새로 입력" autoComplete="off" disabled={disabled || full} value={query}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setActive(-1); setOpen(true); setNotice(""); }}
        onCompositionStart={() => { composing.current = true; onComposingChange?.(true); }}
        onCompositionEnd={() => { composing.current = false; onComposingChange?.(false); }}
        onKeyDown={e => {
          if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault(); e.stopPropagation(); setOpen(true);
            setActive(e.key === "ArrowDown" ? Math.min(options.length - 1, expanded ? activeIndex + 1 : 0)
              : activeIndex < 0 ? options.length - 1 : Math.max(0, activeIndex - 1));
          } else if (e.key === "Escape") {
            e.stopPropagation(); if (open) e.preventDefault(); setOpen(false); setActive(-1);
          } else if (e.key === "Enter" || e.key === ",") {
            e.preventDefault(); e.stopPropagation();
            if (e.key === "Enter" && expanded && activeIndex >= 0) add(options[activeIndex].tag);
            else chooseTyped();
          } else if (e.key === "Tab") { setOpen(false); setActive(-1); }
        }} />
        <button type="button" className="btn secondary tag-toggle" aria-label={expanded ? "태그 목록 닫기" : "태그 목록 열기"} disabled={disabled || full}
          tabIndex={-1} aria-expanded={expanded} onMouseDown={e => e.preventDefault()} onClick={() => { setOpen(!expanded); setActive(-1); input.current?.focus(); }}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {expanded && <div className="tag-popup">
        <ul id={`${id}-list`} role="listbox" aria-label="태그 검색 결과">{options.map((option, index) =>
          <li key={tagKey(option.tag)} id={`${id}-option-${index}`} role="option" aria-selected={activeIndex === index}
            onMouseDown={e => e.preventDefault()} onClick={() => add(option.tag)}>
            {option.create ? <><span>{option.tag}</span><small>새 태그 추가</small></> : option.tag}
          </li>
        )}</ul>
        {!options.length && <p>{selected.has(key) ? "이미 선택한 태그입니다" : tooLong ? "태그는 50자까지 입력할 수 있습니다" : "태그를 입력해 새로 추가하세요"}</p>}
        {matches.length > MAX_OPTIONS && <p>검색 결과 중 {MAX_OPTIONS}개 표시 · 더 입력해 좁혀보세요</p>}
      </div>}
    </div>
    <p className="tag-hint" id={`${id}-hint`}>{full ? "태그 20개 선택됨 · 제거하면 더 선택할 수 있습니다" : tooLong ? "태그는 50자까지 입력할 수 있습니다" : "기존 태그를 선택하거나 입력 후 Enter로 추가"}</p>
    <span className="tag-announcement" role="status">{notice}</span>
  </div>;
}
