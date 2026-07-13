import { createLink, type LinkComponent } from '@tanstack/react-router';
import type { VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';

import { cn } from '@/shared/lib/utils';
import { buttonVariants } from '@/shared/ui/button';

// ボタン見た目のナビゲーションリンク。Base UI の Button は常に role="button" を付与し、
// render で <a> を渡すと <a> のリンク semantics を上書きしてしまう（shadcn 公式もこの用途では
// render ではなく buttonVariants の利用を推奨）。そこで実体を <a>=Link とし buttonVariants で
// スタイルする。createLink でラップすることで TanStack Router の型安全な to/params/search を保つ。
interface ButtonLinkBaseProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>, VariantProps<typeof buttonVariants> {}

const ButtonLinkBase = forwardRef<HTMLAnchorElement, ButtonLinkBaseProps>(
  ({ className, variant, size, ...props }, ref) => (
    <a
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  ),
);
ButtonLinkBase.displayName = 'ButtonLink';

const ButtonLinkImpl = createLink(ButtonLinkBase);

export const ButtonLink: LinkComponent<typeof ButtonLinkBase> = (props) => (
  <ButtonLinkImpl {...props} />
);
