import mermaid from 'mermaid';

// Mermaid の設定はグローバルなので、初期化から描画までを直列に実行する。
let renderQueue: Promise<void> = Promise.resolve();
let nextId = 0;

export function enhanceMermaid(container: HTMLElement): () => void {
  let zoom: HTMLDialogElement | undefined;
  let restoreDiagram: (() => void) | undefined;
  const closeZoom = () => {
    restoreDiagram?.();
    restoreDiagram = undefined;
    zoom?.close();
    zoom?.remove();
    zoom = undefined;
  };
  const openZoom = (output: HTMLElement) => {
    const svg = output.querySelector('svg');
    if (!svg) return;
    closeZoom();
    const dialog = document.createElement('dialog');
    dialog.className = 'mermaid-zoom';
    dialog.setAttribute('aria-label', 'Mermaid の図を拡大表示');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mermaid-zoom-close';
    close.textContent = '閉じる';
    close.addEventListener('click', closeZoom);
    const canvas = document.createElement('div');
    canvas.className = 'mermaid-zoom-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'region');
    canvas.setAttribute('aria-label', '拡大した図');
    // SVG を移動して ID の重複を避け、閉じると元の場所へ戻す。
    canvas.append(svg);
    restoreDiagram = () => output.append(svg);
    dialog.append(close, canvas);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeZoom();
    });
    document.body.append(dialog);
    zoom = dialog;
    dialog.showModal();
  };
  const diagrams = Array.from(
    container.querySelectorAll<HTMLPreElement>('pre[lang="mermaid"]'),
  ).map((source) => {
    const output = document.createElement('div');
    output.className = 'mermaid-diagram';
    output.addEventListener('click', () => openZoom(output));
    output.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openZoom(output);
      }
    });
    source.before(output);
    return { source, output, code: source.querySelector('code')?.textContent ?? '' };
  });
  let generation = 0;
  let disposed = false;

  const render = () => {
    closeZoom();
    const currentGeneration = ++generation;
    for (const { source, output, code } of diagrams) {
      const isStale = () => disposed || currentGeneration !== generation;
      renderQueue = renderQueue.then(async () => {
        if (isStale()) return;
        try {
          const styles = getComputedStyle(container);
          const color = (token: string) => styles.getPropertyValue(token).trim();
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            htmlLabels: false,
            suppressErrorRendering: true,
            look: 'classic',
            theme: 'base',
            fontFamily: styles.fontFamily,
            themeVariables: {
              background: color('--color-surface'),
              primaryColor: color('--color-surface'),
              secondaryColor: color('--color-bg'),
              tertiaryColor: color('--color-surface-raised'),
              primaryTextColor: color('--color-text'),
              secondaryTextColor: color('--color-text'),
              tertiaryTextColor: color('--color-text'),
              primaryBorderColor: color('--color-border'),
              secondaryBorderColor: color('--color-border'),
              tertiaryBorderColor: color('--color-border'),
              lineColor: color('--color-text'),
              textColor: color('--color-text'),
              actorBorder: color('--color-border'),
              actorLineColor: color('--color-text'),
              signalColor: color('--color-text'),
              signalTextColor: color('--color-text'),
              labelBoxBkgColor: color('--color-surface'),
              labelBoxBorderColor: color('--color-border'),
              labelTextColor: color('--color-text'),
              edgeLabelBackground: color('--color-surface'),
            },
          });
          const { svg } = await mermaid.render(`article-mermaid-${++nextId}`, code);
          if (isStale()) return;
          output.innerHTML = svg;
          const diagram = output.querySelector('svg');
          if (diagram?.viewBox.baseVal.width) {
            // 本文では CSS で幅に収め、拡大表示では本来の幅で読めるようにする。
            diagram.style.width = `${diagram.viewBox.baseVal.width}px`;
          }
          output.setAttribute('role', 'button');
          output.setAttribute('aria-label', 'Mermaid の図を拡大');
          output.setAttribute('aria-haspopup', 'dialog');
          output.title = 'クリックして拡大';
          output.tabIndex = 0;
          source.hidden = true;
        } catch {
          if (isStale()) return;
          output.textContent = '図を表示できませんでした。Mermaid の記法を確認してください。';
          output.removeAttribute('role');
          output.removeAttribute('aria-label');
          output.removeAttribute('aria-haspopup');
          output.removeAttribute('tabindex');
          output.removeAttribute('title');
          source.hidden = false;
        }
      });
    }
  };

  const observer = new MutationObserver(render);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  colorScheme.addEventListener('change', render);
  render();

  return () => {
    disposed = true;
    closeZoom();
    observer.disconnect();
    colorScheme.removeEventListener('change', render);
    for (const { source, output } of diagrams) {
      source.hidden = false;
      output.remove();
    }
  };
}
