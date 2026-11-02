import penguin from '../static/penguin-loading.svg';

// Each instance isolates the supplied SVG's styles and clip-path IDs, including
// when several paragraph translations are waiting on the same webpage.
export function renderLoading(target, label, {stacked = false} = {}) {
  const doc = target.ownerDocument;
  const indicator = doc.createElement('span');
  indicator.className = 'pw-loading';
  if (stacked) indicator.setAttribute('data-stacked', '');
  const shadow = indicator.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>
    :host{display:flex;align-items:center;gap:10px;white-space:normal;line-height:1.55}
    .art{display:block;flex:none;width:44px;height:51px;pointer-events:none}
    :host([data-stacked]){flex-direction:column;gap:12px;text-align:center}
    :host([data-stacked]) .art{width:96px;height:112px}
    svg{display:block;width:100%;height:100%}
    progress{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  </style><span class="art" aria-hidden="true">${penguin.replace(/<\?xml[^?]*\?>\s*/, '')}</span><slot></slot>`;
  const progress = doc.createElement('progress');
  progress.setAttribute('aria-label', label);
  shadow.append(progress);
  indicator.textContent = label;
  target.replaceChildren(indicator);
  target.hidden = false;
}
