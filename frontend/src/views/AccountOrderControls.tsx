import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { PointerSensor, PointerActivationConstraints, Accessibility } from "@dnd-kit/dom";
import { GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import type { Account } from "../api";
import { insertOrder, projectBlocks, scopeKey, siblings, swapOrder } from "./accountOrdering";

interface Context { accounts: Account[]; disabled: boolean; save: (a: Account, ids: number[]) => Promise<void>; panel: number | null; setPanel: (id: number | null) => void; dragging: boolean }
const OrderContext = createContext<Context | null>(null);
const sensors = [PointerSensor.configure({
  activationConstraints: [new PointerActivationConstraints.Distance({ value: 6 })],
  preventActivation: event => event.pointerType === "touch" || matchMedia("(max-width:720px), (pointer:coarse)").matches,
})];
interface Boundary { id: string; owner: Account; after: boolean; top: number; left: number; width: number; height: number }
function BoundaryTarget({ boundary }: { boundary: Boundary }) {
  const { ref } = useDroppable({ id: boundary.id });
  return <div ref={ref} aria-hidden="true" className="order-drop-target" style={{ position: "fixed", top: boundary.top, left: boundary.left, width: boundary.width, height: boundary.height }} />;
}
export function AccountOrderProvider({ accounts, disabled, save, children, onDragging }: {
  accounts: Account[]; disabled: boolean; save: Context["save"]; children: ReactNode; onDragging: (value: boolean) => void;
}) {
  const [source, setSource] = useState<Account | null>(null);
  const [panel, setPanel] = useState<number | null>(null);
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  const [marker, setMarker] = useState<Boundary | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  function measure(owner: Account) {
    const clip = document.querySelector(".accounts-ledger-wrap")?.getBoundingClientRect();
    if (!clip) return [];
    return projectBlocks(accounts, owner).flatMap(block => {
      if (block.owner.id === owner.id) return [];
      const elements = [...document.querySelectorAll<HTMLElement>("[data-order-row]")]
        .filter(row => block.rowIds.includes(Number(row.dataset.orderRow)));
      if (!elements.length) return [];
      const top = elements[0].getBoundingClientRect().top;
      const bottom = elements[elements.length - 1].getBoundingClientRect().bottom;
      return [false, true].map(after => ({ id: `${scopeKey(owner)}:${block.owner.id}:${after ? "after" : "before"}`,
        owner: block.owner, after, top: after ? (top + bottom) / 2 : top,
        left: clip.left, width: clip.width, height: (bottom - top) / 2 }));
    });
  }
  function targetAt(owner: Account, point: { x: number; y: number }) {
    return measure(owner).find(b => point.x >= b.left && point.x <= b.left + b.width
      && point.y >= b.top && point.y <= b.top + b.height) ?? null;
  }
  useEffect(() => {
    if (!source) return;
    const update = () => { setBoundaries(measure(source)); if (lastPointer.current) setMarker(targetAt(source, lastPointer.current)); };
    window.addEventListener("scroll", update, true); window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [source, accounts]);
  return <OrderContext.Provider value={{ accounts, disabled, save, panel, setPanel, dragging: !!source }}>
    <DragDropProvider sensors={sensors} plugins={defaults => defaults.map(plugin => plugin === Accessibility
      ? Accessibility.configure({ screenReaderInstructions: { draggable: "손잡이를 끌어 같은 분류 안에서 이동하세요. Enter 또는 Space를 누르면 위·아래 이동 버튼이 열립니다. Escape로 취소합니다." },
        announcements: { dragstart: () => "순서를 이동하고 있습니다", dragend: (event: { canceled: boolean }) => event.canceled ? "이동을 취소했습니다" : "드래그를 마쳤습니다" } })
      : plugin)}
      onBeforeDragStart={event => { if (disabled) event.preventDefault(); }}
      onDragStart={event => {
        const owner = accounts.find(a => a.id === event.operation.source?.id);
        if (!owner) return;
        setPanel(null); setSource(owner); setBoundaries(measure(owner)); onDragging(true);
      }}
      onDragMove={event => {
        if (!source) return;
        const point = event.operation.position.current;
        lastPointer.current = point; setMarker(targetAt(source, point));
      }}
      onDragEnd={event => {
        const owner = source, target = owner ? targetAt(owner, event.operation.position.current) : null;
        setSource(null); setMarker(null); setBoundaries([]); onDragging(false); lastPointer.current = null;
        if (owner && target && !event.canceled) void save(owner, insertOrder(siblings(accounts, owner).map(a => a.id), owner.id, target.owner.id, target.after));
      }}>
      {children}
      <DragOverlay dropAnimation={null} className="order-drag-overlay">{source ? `${source.name} · ${accounts.find(a => a.id === source.parent_id)?.name ?? "최상위"}` : null}</DragOverlay>
      {source && createPortal(<>{boundaries.map(b => <BoundaryTarget key={b.id} boundary={b} />)}
        {marker && <div className="order-insertion" data-testid="order-insertion" style={{ top: marker.after ? marker.top + marker.height : marker.top, left: marker.left, width: marker.width }} />}</>, document.body)}
    </DragDropProvider>
  </OrderContext.Provider>;
}

export function AccountOrderControls({ account }: { account: Account }) {
  const ctx = useContext(OrderContext)!;
  const peers = siblings(ctx.accounts, account), index = peers.findIndex(a => a.id === account.id);
  const allowed = peers.length > 1;
  const { ref, handleRef, isDragging } = useDraggable({ id: account.id, disabled: ctx.disabled || !allowed });
  const handle = useRef<HTMLButtonElement | null>(null), panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 });
  const expanded = ctx.panel === account.id;
  const close = (returnFocus = true) => { ctx.setPanel(null); if (returnFocus) handle.current?.focus(); };
  useEffect(() => {
    if (!expanded) return;
    const box = handle.current!.getBoundingClientRect();
    setPanelPosition({ top: Math.max(8, Math.min(box.bottom + 4, innerHeight - 150)), left: Math.max(8, Math.min(box.left, innerWidth - 296)) });
    panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!panelRef.current?.contains(event.target as Node) && !handle.current?.contains(event.target as Node)) close(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [expanded]);
  const buttons = <>{([-1, 1] as const).map(direction => <button key={direction} type="button" className="order-move"
    data-order-control={account.id} disabled={ctx.disabled || ctx.dragging || index + direction < 0 || index + direction >= peers.length}
    aria-label={`${account.name} ${direction < 0 ? "위로" : "아래로"} 이동`}
    onClick={() => void ctx.save(account, swapOrder(peers.map(a => a.id), account.id, direction))}>
    {direction < 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}<span className="sr-only">{direction < 0 ? "위로 이동" : "아래로 이동"}</span>
  </button>)}</>;
  if (!allowed) return <span className="order-spacer" />;
  return <><button ref={element => { handle.current = element; ref(element); handleRef(element); }} type="button"
    className="order-handle" data-order-control={account.id} aria-label={`${account.name} 순서 변경`} aria-expanded={expanded}
    aria-controls={expanded ? `order-panel-${account.id}` : undefined} disabled={ctx.disabled}
    onClick={() => { if (!isDragging && !ctx.dragging) ctx.setPanel(expanded ? null : account.id); }}>
    <GripVertical size={16} aria-hidden="true" /></button>
    <span className="order-mobile">{buttons}</span>
    {expanded && createPortal(<div ref={panelRef} id={`order-panel-${account.id}`} className="order-panel" style={panelPosition}
      aria-label={`${account.name} 순서`} role="group">
      <p>{account.name} · {ctx.accounts.find(a => a.id === account.parent_id)?.name ?? "최상위"} {index + 1}/{peers.length}</p>
      {buttons}<button type="button" className="btn sm secondary" onClick={() => close()}>닫기</button>
    </div>, document.body)}</>;
}
