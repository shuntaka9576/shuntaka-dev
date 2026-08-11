import katex from 'katex';

const MATH_SELECTOR = '[data-math-style="inline"], [data-math-style="display"]';

/** Markdown 変換時に残した TeX を KaTeX で描画する。 */
export function renderMath(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>(MATH_SELECTOR)) {
    if (element.dataset.mathRendered === 'true') continue;

    const tex = element.textContent ?? '';
    katex.render(tex, element, {
      displayMode: element.dataset.mathStyle === 'display',
      throwOnError: false,
    });
    element.dataset.mathRendered = 'true';
  }
}
