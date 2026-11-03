import { useLayoutEffect, useRef, type PropsWithChildren } from 'react';
import { TideIcon } from '@/components/icons';
import '@/modules/auth/auth-motion.css';

/** 双端共用满页品牌背景与白色悬浮认证卡片。 */
export function AuthLayout({
  children,
  registration = false,
}: PropsWithChildren<{ registration?: boolean }>) {
  const cardRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const content = contentRef.current;
    if (!card || !content) return;
    const measure = () => {
      const style = getComputedStyle(card);
      const height = Math.ceil(
        content.getBoundingClientRect().height +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth),
      );
      const value = `${height}px`;
      if (card.style.getPropertyValue('--auth-card-height') !== value)
        card.style.setProperty('--auth-card-height', value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [registration]);

  return (
    <div className="auth-page flex min-h-svh flex-col bg-accent px-[40px] py-[24px] text-left text-foreground [background-image:radial-gradient(ellipse_at_12%_28%,rgba(94,194,207,0.18),transparent_48%),radial-gradient(ellipse_at_90%_85%,rgba(144,210,219,0.22),transparent_50%)] [&_*]:box-border max-[580px]:px-[16px] max-[580px]:py-[20px]">
      <div className="auth-atmosphere" aria-hidden="true">
        <div className="auth-aurora" />
        <svg
          className="auth-tide-field"
          viewBox="0 0 1600 1000"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
        >
          <defs>
            <linearGradient
              id="auth-tide-current"
              x1="0"
              y1="0"
              x2="1600"
              y2="1000"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="var(--primary)" stopOpacity="0.1" />
              <stop offset="0.45" stopColor="var(--primary)" stopOpacity="0.55" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0.15" />
            </linearGradient>
          </defs>
          <g className="auth-tide-contours">
            <ellipse cx="800" cy="530" rx="920" ry="300" transform="rotate(-18 800 530)" />
            <ellipse cx="800" cy="530" rx="920" ry="330" transform="rotate(-18 800 530)" />
            <ellipse cx="800" cy="530" rx="920" ry="360" transform="rotate(-18 800 530)" />
          </g>
          <g className="auth-tide-orbit">
            <circle cx="1080" cy="420" r="460" stroke="currentColor" strokeDasharray="2 20" />
            <circle cx="1080" cy="-40" r="5" fill="var(--primary)" />
            <circle cx="1080" cy="880" r="4" fill="var(--color-pending-accent)" />
          </g>
          <g stroke="url(#auth-tide-current)">
            <path d="M-160 670C180 390 350 980 780 700S1280 230 1760 520" strokeWidth="2" />
            <path d="M-160 694C180 414 350 1004 780 724S1280 254 1760 544" />
            <path d="M-160 718C180 438 350 1028 780 748S1280 278 1760 568" opacity="0.55" />
            <path d="M-160 200C240 520 500 60 940 240S1360 550 1760 180" />
            <path d="M-160 220C240 540 500 80 940 260S1360 570 1760 200" opacity="0.4" />
          </g>
          <path
            className="auth-tide-pulse"
            d="M-160 670C180 390 350 980 780 700S1280 230 1760 520"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="6 280"
          />
        </svg>
      </div>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳转到主要内容
      </a>
      <header className="flex w-full items-center gap-[12px]">
        <span className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_7px_14px_rgba(29,132,153,0.22)]">
          <TideIcon className="h-[27px] w-[27px] fill-none stroke-current [stroke-linecap:round] [stroke-width:2]" />
        </span>
        <div>
          <div className="text-[21px] leading-[1.1] font-[650] text-foreground">
            Tyde{' '}
            <span className="ml-[5px] inline-block translate-y-[-3px] rounded-lg bg-[var(--color-pending-accent)] px-[6px] py-[3px] text-[12px] text-white">
              潮汐
            </span>
          </div>
          <div className="mt-[6px] font-mono text-[10px] leading-[1.2] tracking-[1px] text-[var(--color-primary-strong)]">
            MARITIME RESOURCE COORDINATION
          </div>
        </div>
      </header>

      <div
        className={`auth-columns mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-[80px] py-[12px] max-[1100px]:gap-[40px] max-[900px]:block max-[900px]:pt-[24px] ${registration ? 'grid-cols-[minmax(0,1fr)_minmax(0,600px)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,460px)]'}`}
      >
        <aside className="auth-intro min-w-0 text-left max-[900px]:hidden">
          <p className="text-[11px] tracking-[2.5px] text-primary">YOUR NEXT CHAPTER</p>
          <p className="mt-[20px] text-[clamp(34px,4.3vw,52px)] leading-[1.45] font-[650] tracking-[-1px] text-foreground">
            从潮汐，
            <br />
            开启新的可能。
          </p>
          <p className="mt-[24px] text-[16px] leading-[1.9] text-muted-foreground">
            让每一次协作，都顺势而为
            <br />
            欢迎来到 tyde
          </p>
        </aside>

        <main
          ref={cardRef}
          id="main-content"
          tabIndex={-1}
          className={`auth-card w-full min-w-0 rounded-[24px] border border-white/80 bg-card shadow-[0_24px_70px_-20px_rgba(28,87,101,0.25),0_4px_16px_rgba(28,87,101,0.04)] max-[900px]:mx-auto max-[900px]:max-w-[600px] max-[580px]:rounded-[20px] max-[580px]:py-[24px] ${registration ? 'px-[28px] py-[24px] max-[580px]:px-[16px]' : 'p-[36px] max-[580px]:px-[24px]'}`}
        >
          <div className="auth-card-viewport">
            <div ref={contentRef}>{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}
