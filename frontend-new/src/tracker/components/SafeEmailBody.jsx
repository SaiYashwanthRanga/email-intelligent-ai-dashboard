import React, { useCallback, useMemo, useRef, useState } from 'react';

// Renders an email body (HTML or plain text) in a sandboxed iframe.
//
// The sandbox deliberately has NO allow-scripts: email HTML is untrusted, and
// scripts inside it must never run with the dashboard's origin. allow-same-origin
// is kept only so this component can measure the content height — without
// scripts, the frame can't do anything with that access. Links open in a new
// tab via <base target="_blank">.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function SafeEmailBody({ body, minHeight = 80 }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(minHeight);

  const srcDoc = useMemo(() => {
    if (!body) return '';
    const isHtml = /<[a-z][^>]*>/i.test(body);
    const content = isHtml
      // cid: images live inside the MIME message; browsers can't load them.
      ? body.replace(/src=["'`]cid:[^"'`]*["'`]/gi, `src="${PIXEL}"`)
      : `<div style="white-space:pre-wrap">${escapeText(body)}</div>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#1f2937;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Calibri,Arial,sans-serif;}
  body{padding:14px 16px;overflow-x:auto;word-wrap:break-word;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  a{color:#2563eb;}
</style></head><body>${content}</body></html>`;
  }, [body]);

  const measure = useCallback(() => {
    try {
      const doc = ref.current?.contentDocument;
      if (!doc?.body) return;
      const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
      if (h > 0) setHeight(Math.max(minHeight, h + 4));
    } catch { /* cross-origin — keep the default height */ }
  }, [minHeight]);

  const onLoad = useCallback(() => {
    measure();
    setTimeout(measure, 400);   // images settle after first layout
  }, [measure]);

  if (!body) return <div className="trk-muted trk-mail__empty">No content.</div>;

  return (
    <iframe
      ref={ref}
      title="Email content"
      className="trk-mail__frame"
      srcDoc={srcDoc}
      onLoad={onLoad}
      style={{ height }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
    />
  );
}
