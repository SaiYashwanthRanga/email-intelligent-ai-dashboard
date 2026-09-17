import React from 'react';
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Link as LinkIcon,
  RemoveFormatting, Subscript, Superscript, IndentIncrease, IndentDecrease,
  Baseline, Highlighter,
} from 'lucide-react';

// Shared formatting bar for every contentEditable compose/reply/forward/
// signature box (ComposeMailModal.jsx, DashboardView.jsx's reply pane, and
// AdminView.jsx's signature editor). Uses document.execCommand — old API,
// but it's the only zero-dependency way to apply real inline formatting to
// a contentEditable region, and every target browser here still supports it.
//
// onMouseDown preventDefault on every interactive control is required, not
// decorative: without it, clicking a toolbar control blurs the editable
// area first, which collapses the text selection execCommand needs to know
// what to format — so clicks would silently do nothing.
const btnStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: '28px', height: '28px', border: 'none', background: 'transparent',
  color: 'var(--text-secondary)', cursor: 'pointer', borderRadius: '5px', flexShrink: 0,
};

const selectStyle = {
  height: '28px', border: '1px solid var(--border-color)',
  borderRadius: '5px', background: 'var(--bg-main)', color: 'var(--text-primary)',
  fontSize: '0.78rem', padding: '0 4px', flexShrink: 0,
};

const Divider = () => <div style={{ width: '1px', height: '18px', background: 'var(--border-color)', margin: '0 4px', flexShrink: 0 }} />;

export default function RichTextToolbar({ targetRef }) {
  const exec = (command, value = null) => {
    targetRef.current?.focus();
    document.execCommand(command, false, value);
  };

  const insertLink = () => {
    const url = window.prompt('Link URL:');
    if (url) exec('createLink', url);
  };

  const Btn = ({ onClick, title, children }) => (
    <button
      type="button"
      title={title}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      style={btnStyle}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,217,255,0.12)'; e.currentTarget.style.color = '#00d9ff'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
    >
      {children}
    </button>
  );

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '2px', padding: '6px 10px',
      borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap',
    }}>
      <select
        title="Font size"
        defaultValue="3"
        onMouseDown={e => e.preventDefault()}
        onChange={e => exec('fontSize', e.target.value)}
        style={{ ...selectStyle, width: '82px' }}
      >
        <option value="2">Small</option>
        <option value="3">Normal</option>
        <option value="5">Large</option>
        <option value="7">Huge</option>
      </select>

      <select
        title="Style"
        defaultValue=""
        onMouseDown={e => e.preventDefault()}
        onChange={e => { exec('formatBlock', e.target.value || 'p'); e.target.value = ''; }}
        style={{ ...selectStyle, width: '90px', marginRight: '4px' }}
      >
        <option value="">Normal</option>
        <option value="h2">Heading</option>
        <option value="blockquote">Quote</option>
      </select>

      <Btn title="Bold" onClick={() => exec('bold')}><Bold size={14} /></Btn>
      <Btn title="Italic" onClick={() => exec('italic')}><Italic size={14} /></Btn>
      <Btn title="Underline" onClick={() => exec('underline')}><Underline size={14} /></Btn>
      <Btn title="Strikethrough" onClick={() => exec('strikeThrough')}><Strikethrough size={14} /></Btn>
      <Btn title="Subscript" onClick={() => exec('subscript')}><Subscript size={14} /></Btn>
      <Btn title="Superscript" onClick={() => exec('superscript')}><Superscript size={14} /></Btn>

      <label title="Text color" style={{ ...btnStyle, position: 'relative', overflow: 'hidden' }}>
        <Baseline size={14} />
        <input
          type="color"
          onMouseDown={e => e.preventDefault()}
          onChange={e => exec('foreColor', e.target.value)}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        />
      </label>
      <label title="Highlight color" style={{ ...btnStyle, position: 'relative', overflow: 'hidden' }}>
        <Highlighter size={14} />
        <input
          type="color"
          onMouseDown={e => e.preventDefault()}
          onChange={e => exec('hiliteColor', e.target.value)}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        />
      </label>

      <Divider />

      <Btn title="Bullet list" onClick={() => exec('insertUnorderedList')}><List size={14} /></Btn>
      <Btn title="Numbered list" onClick={() => exec('insertOrderedList')}><ListOrdered size={14} /></Btn>
      <Btn title="Decrease indent" onClick={() => exec('outdent')}><IndentDecrease size={14} /></Btn>
      <Btn title="Increase indent" onClick={() => exec('indent')}><IndentIncrease size={14} /></Btn>
      <Btn title="Insert link" onClick={insertLink}><LinkIcon size={14} /></Btn>
      <Btn title="Clear formatting" onClick={() => exec('removeFormat')}><RemoveFormatting size={14} /></Btn>
    </div>
  );
}
