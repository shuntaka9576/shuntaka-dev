'use client';

import { useEffect, useRef } from 'react';

type Props = {
  width?: number;
  height?: number;
  className?: string;
};

export function HashiMascot({ width = 32, height = 42, className }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const stalkRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const stalk = stalkRef.current;
    if (!svg || !stalk) return;

    const VB_X = 8;
    const VB_W = 768;
    const VB_Y = 8;
    const VB_H = 1008;
    const TEA_CX = 392;
    const TEA_CY = 170;
    const STALK_PIVOT_X = 392;
    const STALK_PIVOT_Y = 188;
    const IDLE_X = 14;
    const IDLE_Y = 6;
    const IDLE_TILT = 6;
    const MAX_OFFSET_X = 90;
    const MAX_OFFSET_Y = 10;
    const FALLOFF_PX = 260;
    const LERP = 0.08;

    let rafId = 0;
    let hasInput = false;
    const cursor = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    const start = performance.now();

    const tick = () => {
      const t = (performance.now() - start) / 1000;
      let tx = Math.sin(t * 0.7) * IDLE_X + Math.sin(t * 1.6) * (IDLE_X * 0.3);
      let ty = Math.cos(t * 1.1) * IDLE_Y;
      const tilt = Math.sin(t * 0.55) * IDLE_TILT;

      if (hasInput) {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0) {
          const teaX = rect.left + ((TEA_CX - VB_X) / VB_W) * rect.width;
          const teaY = rect.top + ((TEA_CY - VB_Y) / VB_H) * rect.height;
          const dx = cursor.x - teaX;
          const dy = cursor.y - teaY;
          const dist = Math.hypot(dx, dy);
          const factor = Math.min(1, dist / FALLOFF_PX);
          const angle = Math.atan2(dy, dx);
          tx += Math.cos(angle) * MAX_OFFSET_X * factor;
          ty += Math.sin(angle) * MAX_OFFSET_Y * factor;
        }
      }

      current.x += (tx - current.x) * LERP;
      current.y += (ty - current.y) * LERP;
      stalk.setAttribute(
        'transform',
        `translate(${current.x.toFixed(2)} ${current.y.toFixed(2)}) rotate(${tilt.toFixed(2)} ${STALK_PIVOT_X} ${STALK_PIVOT_Y})`,
      );
      rafId = requestAnimationFrame(tick);
    };

    const onMove = (e: MouseEvent) => {
      cursor.x = e.clientX;
      cursor.y = e.clientY;
      hasInput = true;
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    rafId = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      viewBox="8 8 768 1008"
      width={width}
      height={height}
      role="img"
      aria-label="hashi"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#20221c"
        d="M 643 889 Q 642 894 642 923 Q 642 937 641 943 Q 637 954 631 962 C 621 974 607 982 592 988 Q 575 994 555 999 Q 521 1007 482 1011 Q 392 1021 302 1011 Q 263 1007 229 999 Q 209 994 192 988 C 177 982 163 974 153 962 Q 147 954 143 943 Q 142 937 142 923 Q 142 894 142 890 Q 121 877 102 860 Q 56 822 33 768 Q 22 742 16 712 Q 9 682 9 655 V 156 C 9 151 8 146 8 142 C 9 123 18 106 33 93 Q 52 77 74 66 Q 98 53 126 44 Q 169 31 215 23 Q 264 15 311 11 Q 392 5 473 11 Q 520 15 569 23 Q 615 31 658 44 Q 686 53 710 66 Q 732 77 751 93 C 766 106 775 123 776 142 C 776 146 775 151 775 156 V 655 Q 775 682 768 712 Q 762 742 751 768 Q 728 822 682 860 Q 663 877 643 889 Z"
      />
      <path
        fill="#6E9050"
        d="M 392 35 Q 450 35 508 41 C 553 46 599 54 642 67 Q 668 76 693 87 C 721 100 773 132 738 167 Q 733 173 729 176 Q 719 166 706 158 C 686 146 664 136 642 130 Q 608 119 569 112 C 512 101 450 96 392 96 C 334 96 272 101 215 112 Q 176 119 142 130 C 120 136 98 146 78 158 Q 65 166 55 176 Q 51 173 46 167 C 11 132 63 100 91 87 Q 116 76 142 67 C 185 54 231 46 276 41 Q 334 35 392 35 Z"
      />
      <path
        fill="#BDE030"
        d="M 392 123 C 437 123 482 126 526 132 Q 557 135 597 144 Q 629 152 658 163 Q 677 171 692 181 Q 699 186 705 191 C 686 202 664 211 642 217 Q 609 226 570 233 C 512 242 452 246 392 246 C 332 246 272 242 214 233 Q 175 226 142 217 C 120 211 98 202 79 191 Q 85 186 92 181 Q 107 171 126 163 Q 155 152 187 144 Q 227 135 258 132 C 302 126 347 123 392 123 Z"
      />

      <g ref={stalkRef} transform="translate(0 0)">
        <rect x="388" y="150" width="8" height="38" rx="4" fill="#5a3a1f" />
      </g>

      <path
        fill="#6E9050"
        d="M 35 193 Q 42 198 50 203 C 70 218 94 229 117 236 Q 149 247 185 254 Q 235 264 286 268 Q 392 278 498 268 Q 549 264 599 254 Q 635 247 667 236 C 690 229 714 218 734 203 Q 742 198 749 193 V 640 Q 749 647 749 653 C 749 663 749 668 747 678 Q 743 726 722 768 C 698 816 658 853 611 875 Q 588 887 561 894 Q 528 903 497 906 C 445 913 393 914 392 911 C 391 914 339 913 287 906 Q 256 903 223 894 Q 196 887 173 875 C 126 853 86 816 62 768 Q 41 726 37 678 V 653 Q 35 647 35 640 V 193 Z"
      />
      <ellipse fill="#20221c" cx="248" cy="468" rx="40" ry="44" />
      <ellipse fill="#20221c" cx="536" cy="468" rx="40" ry="44" />
      <circle fill="#e8a78d" cx="160" cy="564" r="52" />
      <circle fill="#e8a78d" cx="624" cy="564" r="52" />
      <path
        fill="#20221c"
        d="M 392 580 C 408 580 424 572 432 560 Q 440 552 444 536 Q 448 532 460 532 C 468 532 472 540 472 548 C 472 552 468 560 464 564 C 448 592 424 604 392 604 C 360 604 336 592 320 564 C 316 560 312 552 312 548 C 312 540 316 532 324 532 Q 336 532 340 536 Q 344 552 352 560 C 360 572 376 580 392 580 Z"
      />
      <path
        fill="#6E9050"
        d="M 392 939 C 443 939 493 936 542 925 Q 579 917 616 902 Q 616 923 616 925 Q 616 933 615 937 C 611 948 601 955 591 960 Q 573 967 552 972 Q 519 981 486 984 Q 438 989 392 989 Q 346 989 298 984 Q 265 981 232 972 Q 211 967 193 960 C 183 955 173 948 169 937 Q 168 933 168 925 Q 168 923 168 902 Q 205 917 242 925 C 291 936 341 939 392 939 Z"
      />
    </svg>
  );
}
