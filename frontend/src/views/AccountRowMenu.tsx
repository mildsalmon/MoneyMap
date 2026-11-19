import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

interface Action {
  label: string;
  disabled?: boolean;
  run: () => void;
}

export function AccountRowMenu({ id, name, actions }: { id: number; name: string; actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const label = `${name} 더보기`;
  const menuId = `account-row-menu-${id}`;

  useLayoutEffect(() => {
    if (!open) return;
    const panel = menu.current!;
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      panel.style.left = `${Math.max(4, Math.min(rect.right, innerWidth - 4) - panel.offsetWidth)}px`;
      panel.style.top = `${rect.bottom + panel.offsetHeight + 4 <= innerHeight
        ? rect.bottom + 4 : Math.max(4, rect.top - panel.offsetHeight - 4)}px`;
    };
    position();
    panel.querySelector("button")?.focus({ preventScroll: true });
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return <span className="account-more" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" id={`${menuId}-trigger`} className="btn sm secondary" ref={trigger} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(!open)}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {open && <div ref={menu} id={menuId} role="menu" aria-label={label} className="account-row-menu"
      onKeyDown={event => {
        if (event.key === "Escape" || (event.key === "Tab" && event.shiftKey)) {
          event.preventDefault();
          close();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll("button")];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          items[(index + step + items.length) % items.length].focus();
        }
      }}>
      {actions.map(action => <button key={action.label} type="button" role="menuitem" tabIndex={-1}
        aria-disabled={action.disabled || undefined}
        onClick={() => {
          if (action.disabled) return;
          close();
          action.run();
        }}>{action.label}</button>)}
    </div>}
  </span>;
}
