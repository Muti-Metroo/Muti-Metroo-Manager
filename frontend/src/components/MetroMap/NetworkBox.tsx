import { useEffect, useRef } from 'react';
import type { NetworkBox as NetworkBoxData } from './networkLayout';
import { monoTextWidth } from './layout';

interface NetworkBoxProps {
  box: NetworkBoxData;
  // Display name (identifier when no override is set).
  name: string;
  editing: boolean;
  onCommit: (id: string, name: string) => void;
  onCancel: () => void;
}

// Must match .network-box-label-text in styles/metro.css; monoTextWidth turns
// it into a width without measuring the DOM.
const LABEL_FONT_SIZE = 15;

// A single network box: a rounded rectangle enclosing its members with an
// editable name label sitting on the top-left border. Only the border (a wide
// invisible hit stroke) and the label are pointer targets — the fill is inert
// so clicks inside the box still reach stations and the pan surface. The box's
// <g> carries data-network-id so MetroMap's pointer handler can start a
// box-drag; the label carries data-network-label so a click (vs drag) there
// enters rename mode.
export default function NetworkBox({ box, name, editing, onCommit, onCancel }: NetworkBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const labelW = Math.max(40, monoTextWidth(name, LABEL_FONT_SIZE) + 14);
  const labelX = box.x + 14;
  // The label sits as a tab ON TOP of the border — its bottom edge at the box
  // top (box.y) — so it never overlaps a member's own name label, which is
  // rendered above the node inside the box.
  // Kept under networkLayout's LEVEL_INSET so a nested box's tab clears its
  // parent's border.
  const labelH = LABEL_FONT_SIZE * 1.5;
  const labelTop = box.y - labelH;
  const labelCY = box.y - labelH / 2;

  return (
    <g className={`network-box${box.violated ? ' violated' : ''}`} data-network-id={box.id}>
      <rect
        className="network-box-fill"
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={16}
        ry={16}
      />
      <rect
        className="network-box-hit"
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={16}
        ry={16}
        fill="none"
      />
      {editing ? (
        <foreignObject
          x={labelX - 4}
          y={labelTop - 2}
          width={Math.max(160, labelW + 20)}
          height={labelH + 6}
          onPointerDown={e => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            className="network-box-input"
            defaultValue={name}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onPointerDown={e => e.stopPropagation()}
            onBlur={e => onCommit(box.id, e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
          />
        </foreignObject>
      ) : (
        <g className="network-box-label" data-network-label="1">
          <rect
            className="network-box-label-bg"
            x={labelX - 6}
            y={labelTop}
            width={labelW}
            height={labelH}
            rx={4}
            ry={4}
          />
          <text
            className="network-box-label-text"
            x={labelX}
            y={labelCY}
            dominantBaseline="central"
          >
            {name}
          </text>
        </g>
      )}
    </g>
  );
}
